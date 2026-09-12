import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Context,
  ROOT_CONTEXT,
  Span,
  SpanContext,
  SpanKind,
  TraceFlags,
  context,
  isSpanContextValid,
  trace,
} from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  ReadableSpan,
  SpanExporter,
  SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { MetricsService } from './metrics';
import {
  finishSpan,
  inTraceContext,
  TelemetryPort,
  TraceAttributes,
  TraceCarrier,
  TraceSpanName,
} from './telemetry.types';

/** Безопасное представление завершённого span для contract/integration тестов. */
export type CompletedSpan = Readonly<{
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  attributes: Readonly<Record<string, unknown>>;
}>;

/**
 * Bounded in-memory processor хранит последние spans для диагностики и тестов.
 *
 * Это не durable storage: при переполнении старейший span удаляется, а internal
 * metric сообщает о потере non-critical telemetry. Business state не затрагивается.
 */
class InspectionSpanProcessor implements SpanProcessor {
  /** Кольцевой bounded buffer хранит только безопасные summaries завершённых spans. */
  private readonly spans: CompletedSpan[] = [];

  /**
   * Создаёт диагностический processor без фонового I/O.
   *
   * @param metrics Получатель счётчика вытесненных spans.
   * @param capacity Максимальное число summaries; старейшая запись вытесняется.
   */
  constructor(
    private readonly metrics: MetricsService,
    private readonly capacity: number,
  ) {}

  /**
   * Реализует обязательный SDK hook начала span без дополнительной работы.
   * Processor сознательно собирает только завершённые spans, поэтому hot path не
   * получает allocation сверх самой операции OpenTelemetry SDK.
   */
  onStart(span: Span, parentContext: Context): void {
    void span;
    void parentContext;
  }

  /**
   * Сохраняет bounded summary завершённого span.
   * При заполненном buffer удаляется ровно один старейший элемент и увеличивается
   * internal drop metric; payload, events и links в snapshot не копируются.
   */
  onEnd(span: ReadableSpan): void {
    if (this.spans.length >= this.capacity) {
      this.spans.shift();
      this.metrics.telemetryDropped('traces', 'queue_full');
    }
    this.spans.push({
      name: span.name,
      traceId: span.spanContext().traceId,
      spanId: span.spanContext().spanId,
      parentSpanId: span.parentSpanContext?.spanId ?? null,
      attributes: span.attributes,
    });
  }

  /** In-memory processor не имеет фоновой очереди. */
  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  /** Shutdown оставляет уже собранные summaries доступными до GC. */
  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  /** Возвращает immutable snapshot без выдачи внутреннего массива. */
  snapshot(): readonly CompletedSpan[] {
    return [...this.spans];
  }
}

/**
 * Экспортер для режима `OTEL_TRACES_ENABLED=false`.
 * Он подтверждает batch без сети: instrumentation и trace/log correlation можно
 * тестировать локально, не ожидая Collector и не создавая retry storm.
 */
class DisabledSpanExporter implements SpanExporter {
  /** Подтверждает batch, поскольку локальное tracing остаётся работоспособным. */
  export(_spans: ReadableSpan[], callback: Parameters<SpanExporter['export']>[1]): void {
    callback({ code: 0 });
  }

  /** Нет внешних ресурсов для освобождения. */
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Изолирует отказ OTLP exporter от BatchSpanProcessor и business operation.
 * Callback всегда вызывается исходным exporter; дополнительно фиксируется только
 * internal metric с bounded reason, без endpoint URL или содержимого spans.
 */
export class ResilientSpanExporter implements SpanExporter {
  /**
   * Оборачивает любой SDK exporter политикой failure isolation.
   *
   * @param delegate Реальный OTLP exporter либо тестовая реализация.
   * @param metrics Internal metrics, куда записывается bounded причина отказа.
   */
  constructor(
    private readonly delegate: SpanExporter,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * Передаёт batch делегату и гарантированно завершает SDK callback.
   * Sync exception не выходит в application flow; unsuccessful result сохраняет
   * исходный код для BatchSpanProcessor и одновременно увеличивает failure metric.
   */
  export(spans: ReadableSpan[], callback: Parameters<SpanExporter['export']>[1]): void {
    try {
      this.delegate.export(spans, (result) => {
        if (Number(result.code) !== 0) this.metrics.exporterFailed('traces', 'export_error');
        callback(result);
      });
    } catch {
      this.metrics.exporterFailed('traces', 'export_error');
      callback({ code: 1, error: new Error('Trace exporter failed') });
    }
  }

  /** Shutdown failure также не выходит за observability boundary. */
  async shutdown(): Promise<void> {
    try {
      await this.delegate.shutdown();
    } catch {
      this.metrics.exporterFailed('traces', 'export_error');
    }
  }

  /** Делегирует optional forceFlush с тем же failure isolation. */
  async forceFlush(): Promise<void> {
    try {
      await this.delegate.forceFlush?.();
    } catch {
      this.metrics.exporterFailed('traces', 'export_error');
    }
  }
}

/**
 * OpenTelemetry SDK adapter для W3C context, spans и bounded OTLP export.
 *
 * Adapter создаёт local provider с двумя processors: синхронный bounded summary
 * нужен тестам и диагностике, BatchSpanProcessor отправляет spans вне hot path.
 * Incoming `traceparent` проверяется до создания SERVER/CONSUMER span. Raw IDs
 * используются только как trace context и никогда не становятся metric labels.
 *
 * @example `telemetry.continueSpan(TRACE_SPANS.EVENT_CONSUME, event.trace, {}, fn)`
 * продолжает исходный trace после чтения события из durable log.
 */
@Injectable()
export class TelemetryService implements TelemetryPort, OnModuleDestroy {
  /** Локальный provider владеет processors и не зависит от глобального auto-instrumentation. */
  private readonly provider: BasicTracerProvider;
  /** Tracer создаёт spans с постоянными service name и instrumentation version. */
  private readonly tracer;
  /** Bounded processor используется contract-тестами и локальной диагностикой. */
  private readonly inspector: InspectionSpanProcessor;
  /** AsyncLocalStorage сохраняет активный span между `await` и callbacks. */
  private readonly contextManager = new AsyncLocalStorageContextManager().enable();

  /**
   * Собирает tracing pipeline из валидированной конфигурации приложения.
   *
   * При включённом OTLP используется HTTP exporter; при выключенном — no-network
   * adapter. Batch queue, размер пакета, задержка и timeout ограничены env-полями.
   * Inspector подключается первым, поэтому exporter blackout не мешает локально
   * подтвердить причинную цепочку.
   *
   * @param config Источник OTEL-параметров с безопасными fallback.
   * @param metrics Registry для duration, drop и exporter-failure сигналов.
   */
  constructor(
    config: ConfigService,
    private readonly metrics: MetricsService,
  ) {
    context.setGlobalContextManager(this.contextManager);
    const enabled = this.boolean(config.get<string>('OTEL_TRACES_ENABLED', 'false'));
    const endpoint = config.get<string>(
      'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
      'http://otel-collector:4318/v1/traces',
    );
    const exporter: SpanExporter = enabled
      ? new OTLPTraceExporter({ url: endpoint })
      : new DisabledSpanExporter();
    const capacity = Number(config.get<string | number>('OTEL_DIAGNOSTIC_SPAN_LIMIT', 1000));
    this.inspector = new InspectionSpanProcessor(metrics, capacity);
    const batch = new BatchSpanProcessor(new ResilientSpanExporter(exporter, metrics), {
      maxQueueSize: Number(config.get<string | number>('OTEL_BSP_MAX_QUEUE_SIZE', 2048)),
      maxExportBatchSize: Number(
        config.get<string | number>('OTEL_BSP_MAX_EXPORT_BATCH_SIZE', 256),
      ),
      scheduledDelayMillis: Number(config.get<string | number>('OTEL_BSP_SCHEDULE_DELAY', 5000)),
      exportTimeoutMillis: Number(config.get<string | number>('OTEL_BSP_EXPORT_TIMEOUT', 1000)),
    });
    this.provider = new BasicTracerProvider({
      spanProcessors: [this.inspector, batch],
      spanLimits: { attributeCountLimit: 32, attributeValueLengthLimit: 128 },
    });
    this.tracer = this.provider.getTracer('exchange-backend', '1.0.0');
  }

  /**
   * Создаёт INTERNAL span как ребёнка текущего активного context.
   * Метод прозрачен для return type и не перехватывает бизнес-исключение.
   *
   * @example `telemetry.span(TRACE_SPANS.MATCHING_APPLY, {'command.type':'place'}, () => engine.apply(command))`.
   */
  span<T>(name: TraceSpanName, attributes: TraceAttributes, operation: () => T): T {
    return this.startSpan(name, SpanKind.INTERNAL, context.active(), attributes, operation);
  }

  /**
   * Создаёт SERVER/CONSUMER span поверх проверенного remote W3C context.
   * Invalid или отсутствующий `traceparent` безопасно начинает новый root trace;
   * бизнес-команда из-за диагностической metadata не отклоняется.
   */
  continueSpan<T>(
    name: TraceSpanName,
    carrier: TraceCarrier,
    attributes: TraceAttributes,
    operation: () => T,
    kind: SpanKind = SpanKind.CONSUMER,
  ): T {
    return this.startSpan(name, kind, this.parentContext(carrier), attributes, operation);
  }

  /**
   * Сериализует active SpanContext в W3C carrier для command/event envelope.
   * Sampling flag сохраняется в последнем байте, а вне span возвращается `{}`.
   */
  carrier(): TraceCarrier {
    const active = trace.getSpan(context.active())?.spanContext();
    if (!active || !isSpanContextValid(active)) return {};
    return {
      traceparent: `00-${active.traceId}-${active.spanId}-${Number(active.traceFlags) === Number(TraceFlags.SAMPLED) ? '01' : '00'}`,
      ...(active.traceState ? { tracestate: active.traceState.serialize() } : {}),
    };
  }

  /**
   * Возвращает копию завершённых span summaries.
   * Метод предназначен для integration tests и локальной диагностики, но не
   * публикуется через REST и не заменяет Tempo как production storage.
   */
  completedSpans(): readonly CompletedSpan[] {
    return this.inspector.snapshot();
  }

  /** Flush имеет собственный SDK timeout и не вызывается на request path. */
  forceFlush(): Promise<void> {
    return this.provider.forceFlush({ timeoutMillis: 1500 });
  }

  /** Освобождает batch exporter при graceful shutdown. */
  async onModuleDestroy(): Promise<void> {
    await this.provider.shutdown();
  }

  /**
   * Общая реализация span lifecycle для sync и Promise операций.
   * Сначала фильтруются attributes, затем callback выполняется в active context;
   * span и stage histogram завершаются после фактического завершения Promise.
   */
  private startSpan<T>(
    name: TraceSpanName,
    kind: SpanKind,
    parent: Context,
    attributes: TraceAttributes,
    operation: () => T,
  ): T {
    const safeAttributes = this.attributes(attributes);
    const startedAt = process.hrtime.bigint();
    const span = this.tracer.startSpan(name, { kind, attributes: safeAttributes }, parent);
    try {
      const result = inTraceContext(trace.setSpan(parent, span), operation);
      const observed = finishSpan(span, result);
      if (observed instanceof Promise) {
        return observed.finally(() => this.observeStage(name, startedAt, span)) as T;
      }
      this.observeStage(name, startedAt, span);
      return observed;
    } catch (error) {
      span.recordException(error instanceof Error ? error : String(error));
      span.end();
      this.observeStage(name, startedAt, span, 'failure');
      throw error;
    }
  }

  /**
   * Строит remote parent только из валидного W3C `traceparent` версии 00.
   * Нулевые/повреждённые IDs отбрасывает `isSpanContextValid`; `tracestate` пока
   * не интерпретируется и не влияет на допуск бизнес-команды.
   */
  private parentContext(carrier: TraceCarrier): Context {
    const match = carrier.traceparent?.match(/^00-([0-9a-f]{32})-([0-9a-f]{16})-(0[01])$/i);
    if (!match) return ROOT_CONTEXT;
    const spanContext: SpanContext = {
      traceId: match[1]!.toLowerCase(),
      spanId: match[2]!.toLowerCase(),
      traceFlags: match[3] === '01' ? TraceFlags.SAMPLED : TraceFlags.NONE,
      isRemote: true,
    };
    return isSpanContextValid(spanContext)
      ? trace.setSpanContext(ROOT_CONTEXT, spanContext)
      : ROOT_CONTEXT;
  }

  /**
   * Отбрасывает ID/cardinality-risk attributes до передачи SDK.
   * Фильтр является второй линией защиты: даже если вызывающий код ошибочно
   * передал `orderId`, оно не попадёт в exporter или diagnostic snapshot.
   */
  private attributes(attributes: TraceAttributes): TraceAttributes {
    const forbidden = /(user|account|order|command|event|trade).*id/i;
    return Object.fromEntries(Object.entries(attributes).filter(([key]) => !forbidden.test(key)));
  }

  /** Преобразует строковый feature flag без неявных truthy значений. */
  private boolean(value: string): boolean {
    return value === 'true' || value === '1';
  }

  /** Пишет stage histogram после завершения span. */
  private observeStage(
    name: TraceSpanName,
    startedAt: bigint,
    _span: Span,
    outcome: 'success' | 'failure' = 'success',
  ): void {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    this.metrics.observeStage(name, outcome, durationMs);
  }
}
