import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
  Optional,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Observable, Subscription } from 'rxjs';
import { LOG_EVENTS } from './log-events';
import { LoggingContext } from './logging-context';
import { StructuredLogger } from './structured-logger';
import { MetricsService } from './metrics';
import { TelemetryService } from './tracing';
import { TRACE_SPANS } from './telemetry.types';
import { SpanKind } from '@opentelemetry/api';

/** Минимальная HTTP request shape без headers/body в логируемом контракте. */
type ObservedRequest = Readonly<{
  headers: Readonly<Record<string, string | string[] | undefined>>;
  method?: string;
  url?: string;
}>;

/** Минимальная response shape, общая для Fastify и Express adapters. */
type ObservedResponse = {
  header?(name: string, value: string): void;
  setHeader?(name: string, value: string): void;
  statusCode?: number;
};

/**
 * Создаёт HTTP correlation context и пишет ровно одно terminal событие запроса.
 *
 * Headers и body намеренно не передаются logger-у. Успешное завершение получает
 * `http.request.completed`, exception — `http.request.rejected`; duration
 * измеряется monotonic clock. RxJS subscription создаётся внутри AsyncLocalStorage
 * context, поэтому command/event logs наследуют тот же correlationId.
 */
@Injectable()
export class HttpLoggingInterceptor implements NestInterceptor {
  /**
   * Собирает HTTP boundary из независимых operational adapters.
   *
   * Metrics и telemetry optional, чтобы unit-тесты transport слоя могли не
   * поднимать exporter. При их отсутствии correlation context и безопасный
   * structured log продолжают работать.
   *
   * @param context AsyncLocalStorage-контекст причинной цепочки запроса.
   * @param logger Единый structured logger с централизованной redaction.
   * @param metrics Необязательный сборщик RED-метрик HTTP.
   * @param telemetry Необязательный OpenTelemetry adapter для SERVER span.
   */
  constructor(
    private readonly context: LoggingContext,
    private readonly logger: StructuredLogger,
    @Optional() private readonly metrics?: MetricsService,
    @Optional() private readonly telemetry?: TelemetryService,
  ) {}

  /**
   * Валидирует внешний correlation ID, добавляет его в ответ и открывает span.
   *
   * Observable подписывается внутри AsyncLocalStorage и trace context, поэтому
   * контекст сохраняется до `complete` либо `error`, а не только до возврата
   * объекта Observable. Query string, headers и body не используются как labels.
   *
   * @param execution NestJS-контекст текущего HTTP-вызова.
   * @param next Следующий handler в interceptor chain.
   * @returns Observable, сохраняющий исходный response и error без преобразования.
   */
  intercept(execution: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = execution.switchToHttp().getRequest<ObservedRequest>();
    const response = execution.switchToHttp().getResponse<ObservedResponse>();
    const supplied = request.headers['x-correlation-id'];
    const candidate = Array.isArray(supplied) ? supplied[0] : supplied;
    const correlationId =
      candidate && /^[A-Za-z0-9._:-]{1,128}$/.test(candidate) ? candidate : randomUUID();
    response.header?.('x-correlation-id', correlationId);
    response.setHeader?.('x-correlation-id', correlationId);

    return new Observable((subscriber) => {
      const traceparent = this.header(request.headers['traceparent']);
      const tracestate = this.header(request.headers['tracestate']);
      const subscribe = (terminal?: {
        resolve: () => void;
        reject: (error: unknown) => void;
      }): Subscription =>
        this.context.run({ correlationId }, () => {
          const startedAt = process.hrtime.bigint();
          return next.handle().subscribe({
            next: (value) => subscriber.next(value),
            error: (error: unknown) => {
              const statusCode = error instanceof HttpException ? error.getStatus() : 500;
              const durationMs = this.elapsed(startedAt);
              this.metrics?.observeHttp(
                request.method ?? 'UNKNOWN',
                this.safeRoute(request.url),
                statusCode,
                durationMs,
              );
              this.logger.warn('http', LOG_EVENTS.HTTP_REJECTED, {
                outcome: 'rejected',
                durationMs,
                metadata: {
                  method: request.method ?? 'unknown',
                  route: this.safeRoute(request.url),
                  statusCode,
                  errorType: error instanceof Error ? error.name : 'UnknownError',
                },
              });
              subscriber.error(error);
              terminal?.reject(error);
            },
            complete: () => {
              const statusCode = response.statusCode ?? 200;
              const durationMs = this.elapsed(startedAt);
              this.metrics?.observeHttp(
                request.method ?? 'UNKNOWN',
                this.safeRoute(request.url),
                statusCode,
                durationMs,
              );
              this.logger.info('http', LOG_EVENTS.HTTP_COMPLETED, {
                durationMs,
                metadata: {
                  method: request.method ?? 'unknown',
                  route: this.safeRoute(request.url),
                  statusCode,
                },
              });
              subscriber.complete();
              terminal?.resolve();
            },
          });
        });
      if (!this.telemetry) return subscribe();
      let subscription: Subscription | undefined;
      let cancelTrace: (() => void) | undefined;
      const traced = this.telemetry.continueSpan(
        TRACE_SPANS.HTTP_REQUEST,
        { ...(traceparent ? { traceparent } : {}), ...(tracestate ? { tracestate } : {}) },
        {
          'http.request.method': request.method ?? 'UNKNOWN',
          'http.route': this.safeRoute(request.url),
        },
        () =>
          new Promise<void>((resolve, reject) => {
            cancelTrace = resolve;
            subscription = subscribe({ resolve, reject });
          }),
        SpanKind.SERVER,
      );
      void traced.catch(() => undefined);
      return () => {
        subscription?.unsubscribe();
        cancelTrace?.();
      };
    });
  }

  /** Извлекает одно header value без передачи полного набора заголовков. */
  private header(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
  }

  /** Удаляет query string, чтобы значения фильтров не оказались в логах. */
  private safeRoute(url: string | undefined): string {
    return (url ?? 'unknown').split('?')[0] ?? 'unknown';
  }

  /** Переводит monotonic nanoseconds в миллисекунды с микросекундной точностью. */
  private elapsed(startedAt: bigint): number {
    return Number(process.hrtime.bigint() - startedAt) / 1_000_000;
  }
}
