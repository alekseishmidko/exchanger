import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Observable } from 'rxjs';
import { LOG_EVENTS } from './log-events';
import { LoggingContext } from './logging-context';
import { StructuredLogger } from './structured-logger';

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
  constructor(
    private readonly context: LoggingContext,
    private readonly logger: StructuredLogger,
  ) {}

  /** Валидирует внешний ID, добавляет response header и открывает context. */
  intercept(execution: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = execution.switchToHttp().getRequest<ObservedRequest>();
    const response = execution.switchToHttp().getResponse<ObservedResponse>();
    const supplied = request.headers['x-correlation-id'];
    const candidate = Array.isArray(supplied) ? supplied[0] : supplied;
    const correlationId =
      candidate && /^[A-Za-z0-9._:-]{1,128}$/.test(candidate) ? candidate : randomUUID();
    response.header?.('x-correlation-id', correlationId);
    response.setHeader?.('x-correlation-id', correlationId);

    return new Observable((subscriber) =>
      this.context.run({ correlationId }, () => {
        const startedAt = process.hrtime.bigint();
        return next.handle().subscribe({
          next: (value) => subscriber.next(value),
          error: (error: unknown) => {
            this.logger.warn('http', LOG_EVENTS.HTTP_REJECTED, {
              outcome: 'rejected',
              durationMs: this.elapsed(startedAt),
              metadata: {
                method: request.method ?? 'unknown',
                route: this.safeRoute(request.url),
                statusCode: error instanceof HttpException ? error.getStatus() : 500,
                errorType: error instanceof Error ? error.name : 'UnknownError',
              },
            });
            subscriber.error(error);
          },
          complete: () => {
            this.logger.info('http', LOG_EVENTS.HTTP_COMPLETED, {
              durationMs: this.elapsed(startedAt),
              metadata: {
                method: request.method ?? 'unknown',
                route: this.safeRoute(request.url),
                statusCode: response.statusCode ?? 200,
              },
            });
            subscriber.complete();
          },
        });
      }),
    );
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
