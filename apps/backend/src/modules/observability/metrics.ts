import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { context, isSpanContextValid, trace } from '@opentelemetry/api';
import {
  Counter,
  Gauge,
  Histogram,
  OpenMetricsContentType,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';

/**
 * Границы histogram в секундах от 0.5 ms до 5 s.
 *
 * Мелкие buckets различают sequencer/matching hot path, крупные покрывают HTTP и
 * settlement. Поскольку Prometheus хранит cumulative buckets, из одного набора
 * можно вычислять p50/p95/p99 для разных stages без отдельной summary-метрики.
 */
export const LATENCY_BUCKETS_SECONDS = [
  0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5,
] as const;

/**
 * Allow-list label names каждого прикладного metric.
 *
 * Политика специально исключает userId, orderId, commandId, eventId и raw URL.
 * Contract test сравнивает этот каталог с реально зарегистрированными метриками,
 * поэтому добавление unbounded label блокирует CI.
 */
export const METRIC_LABEL_POLICY = {
  exchange_http_requests_total: ['method', 'route', 'status_class', 'outcome'],
  exchange_http_request_duration_seconds: ['method', 'route', 'outcome'],
  exchange_websocket_messages_total: ['operation', 'channel', 'outcome'],
  exchange_websocket_message_duration_seconds: ['operation', 'outcome'],
  exchange_command_total: ['command_type', 'outcome', 'reason'],
  exchange_trade_total: ['instrument', 'outcome'],
  exchange_settlement_total: ['outcome', 'reason'],
  exchange_reconciliation_differences_total: ['scope'],
  exchange_sequence_gaps_total: ['component'],
  exchange_circuit_breaker_state: ['breaker'],
  exchange_market_data_freshness_seconds: ['channel'],
  exchange_projection_lag_events: ['projection'],
  exchange_consumer_lag_events: ['consumer'],
  exchange_resource_utilization_ratio: ['resource'],
  exchange_resource_saturation_ratio: ['resource'],
  exchange_resource_errors_total: ['resource', 'reason'],
  exchange_stage_duration_seconds: ['stage', 'outcome'],
  exchange_telemetry_export_failures_total: ['signal', 'reason'],
  exchange_telemetry_dropped_total: ['signal', 'reason'],
} as const;

/** Имя метрики, разрешённое публичным observability contract. */
export type MetricName = keyof typeof METRIC_LABEL_POLICY;

/** Создаёт OpenMetrics registry до инициализации exemplar-enabled instruments. */
function createOpenMetricsRegistry(): Registry<OpenMetricsContentType> {
  const registry = new Registry<OpenMetricsContentType>();
  registry.setContentType(Registry.OPENMETRICS_CONTENT_TYPE);
  return registry;
}

/** Минимальный metrics port для domain-классов без NestJS dependency. */
export interface OperationalMetrics {
  /** Учитывает исполненную/отклонённую сделку. */
  observeTrade(instrument: string, outcome: 'executed' | 'rejected'): void;
  /** Учитывает успешный settlement или correctness failure. */
  observeSettlement(outcome: 'applied' | 'failed', reason?: string): void;
  /** Учитывает sequence gap. */
  observeGap(component: 'sequencer' | 'projection' | 'market-data'): void;
  /** Обновляет projection/consumer lag. */
  setLag(kind: 'projection' | 'consumer', name: string, value: number): void;
  /** Отмечает время последней публикации public market data. */
  markMarketDataPublished(channel: 'book' | 'trades' | 'ticker'): void;
}

/** No-op metrics port не меняет domain semantics в isolated unit tests. */
export const NOOP_OPERATIONAL_METRICS: OperationalMetrics = {
  observeTrade: () => undefined,
  observeSettlement: () => undefined,
  observeGap: () => undefined,
  setLag: () => undefined,
  markMarketDataPublished: () => undefined,
};

/**
 * Централизованный Prometheus registry и typed recording API.
 *
 * Все методы принимают только bounded enum-like labels. Raw identifiers никогда
 * не становятся labels; для correlation используются trace exemplars и логи.
 * Default Node.js metrics дают CPU, heap, GC и event-loop USE-сигналы.
 */
@Injectable()
export class MetricsService implements OperationalMetrics, OnModuleDestroy {
  /** Изолированный registry: модуль не загрязняет глобальный registry prom-client. */
  readonly registry = createOpenMetricsRegistry();
  private readonly httpRequests = this.counter('exchange_http_requests_total');
  private readonly httpDuration = this.histogram('exchange_http_request_duration_seconds');
  private readonly commands = this.counter('exchange_command_total');
  private readonly websocketMessages = this.counter('exchange_websocket_messages_total');
  private readonly websocketDuration = this.histogram(
    'exchange_websocket_message_duration_seconds',
  );
  private readonly trades = this.counter('exchange_trade_total');
  private readonly settlements = this.counter('exchange_settlement_total');
  private readonly reconciliation = this.counter('exchange_reconciliation_differences_total');
  private readonly gaps = this.counter('exchange_sequence_gaps_total');
  private readonly circuitBreaker = this.gauge('exchange_circuit_breaker_state');
  private readonly marketDataFreshness = this.gauge('exchange_market_data_freshness_seconds');
  private readonly resourceErrors = this.counter('exchange_resource_errors_total');
  private readonly stageDuration = this.histogram('exchange_stage_duration_seconds');
  private readonly exporterFailures = this.counter('exchange_telemetry_export_failures_total');
  private readonly dropped = this.counter('exchange_telemetry_dropped_total');
  private readonly projectionLag = this.gauge('exchange_projection_lag_events');
  private readonly consumerLag = this.gauge('exchange_consumer_lag_events');
  private readonly resourceUtilization = this.gauge('exchange_resource_utilization_ratio');
  private readonly resourceSaturation = this.gauge('exchange_resource_saturation_ratio');
  private readonly lastMarketDataAt = new Map<string, number>();

  /**
   * Создаёт registry и подключает стандартные метрики Node.js.
   *
   * Default collectors измеряют CPU, память, GC и event-loop lag. Они пишут
   * значения только во время scrape и не запускают сетевой exporter, поэтому
   * отказ Prometheus никак не блокирует application thread.
   */
  constructor() {
    this.registry.setDefaultLabels({ service: 'exchange-backend' });
    collectDefaultMetrics({
      register: this.registry,
      prefix: 'exchange_',
    });
  }

  /**
   * Записывает RED count и duration одного HTTP boundary.
   *
   * URL очищается от query string и ID-подобных сегментов. Status сворачивается
   * в класс `2xx/4xx/5xx`; 4xx считается client error, а 5xx — service failure.
   * Если вызов выполняется внутри span, sample получает trace exemplar.
   *
   * @example `observeHttp('POST', '/api/v1/orders/uuid', 201, 12.5)`.
   */
  observeHttp(method: string, route: string, statusCode: number, durationMs: number): void {
    const outcome = statusCode < 500 ? (statusCode < 400 ? 'success' : 'client_error') : 'failure';
    const boundedRoute = this.normalizeRoute(route);
    const labels = {
      method: method.toUpperCase(),
      route: boundedRoute,
      status_class: `${Math.floor(statusCode / 100)}xx`,
      outcome,
    };
    this.httpRequests.inc({ labels, exemplarLabels: this.exemplar() });
    this.httpDuration.observe({
      labels: { method: labels.method, route: boundedRoute, outcome },
      value: durationMs / 1000,
      exemplarLabels: this.exemplar(),
    });
  }

  /**
   * Учитывает результат admission без commandId и account metadata.
   * Неизвестная причина превращается в `unknown`, чтобы exception message не
   * создавал новую series и не попадал в monitoring backend.
   */
  observeCommand(
    commandType: 'place' | 'cancel',
    outcome: 'accepted' | 'rejected',
    reason = 'none',
  ): void {
    this.commands.inc({
      labels: { command_type: commandType, outcome, reason: this.boundedReason(reason) },
      exemplarLabels: this.exemplar(),
    });
  }

  /**
   * Записывает RED-сигналы WebSocket protocol message.
   * Operation и channel проходят allow-list; socket ID, request ID и user ID
   * намеренно не принимаются методом и поэтому не могут стать labels.
   */
  observeWebSocket(
    operation: string,
    channel: string,
    outcome: 'success' | 'failure',
    durationMs: number,
  ): void {
    const boundedOperation = [
      'subscribe',
      'unsubscribe',
      'resync',
      'heartbeat',
      'publish',
    ].includes(operation)
      ? operation
      : 'unknown';
    const boundedChannel = ['book', 'trades', 'ticker', 'user', 'control'].includes(channel)
      ? channel
      : 'unknown';
    this.websocketMessages.inc({
      labels: { operation: boundedOperation, channel: boundedChannel, outcome },
      exemplarLabels: this.exemplar(),
    });
    this.websocketDuration.observe({
      labels: { operation: boundedOperation, outcome },
      value: durationMs / 1000,
      exemplarLabels: this.exemplar(),
    });
  }

  /** Учитывает trade result с bounded instrument catalog fallback. */
  observeTrade(instrument: string, outcome: 'executed' | 'rejected'): void {
    this.trades.inc({
      labels: { instrument: this.boundedInstrument(instrument), outcome },
      exemplarLabels: this.exemplar(),
    });
  }

  /**
   * Учитывает settlement correctness signal.
   * `failed/invariant` является событием с нулевым error budget и немедленно
   * переводит финансовый alert в firing; сумма сделки в metric не записывается.
   */
  observeSettlement(outcome: 'applied' | 'failed', reason = 'none'): void {
    this.settlements.inc({
      labels: { outcome, reason: this.boundedReason(reason) },
      exemplarLabels: this.exemplar(),
    });
  }

  /** Фиксирует reconciliation difference без account/asset labels. */
  observeReconciliationDifference(scope: 'ledger' | 'event-log' | 'projection'): void {
    this.reconciliation.inc({ labels: { scope }, exemplarLabels: this.exemplar() });
  }

  /** Фиксирует sequence gap по bounded component. */
  observeGap(component: 'sequencer' | 'projection' | 'market-data'): void {
    this.gaps.inc({ labels: { component }, exemplarLabels: this.exemplar() });
  }

  /**
   * Экспортирует состояние circuit breaker как gauge.
   * Числовое кодирование: `closed=0`, `half_open=0.5`, `open=1`; имя breaker
   * проходит bounded component catalog.
   */
  setCircuitBreaker(breaker: string, state: 'closed' | 'open' | 'half_open'): void {
    this.circuitBreaker.set(
      { breaker: this.boundedComponent(breaker) },
      state === 'open' ? 1 : state === 'half_open' ? 0.5 : 0,
    );
  }

  /**
   * Запоминает время последней публикации public market data.
   * Возраст не фиксируется нулём навсегда: метод `render` пересчитывает секунды от
   * timestamp до scrape, поэтому остановившийся producer даёт растущий gauge.
   */
  markMarketDataPublished(channel: 'book' | 'trades' | 'ticker'): void {
    this.lastMarketDataAt.set(channel, Date.now());
  }

  /** Записывает latency отдельного этапа критического пути. */
  observeStage(stage: string, outcome: 'success' | 'failure', durationMs: number): void {
    this.stageDuration.observe({
      labels: { stage, outcome },
      value: durationMs / 1000,
      exemplarLabels: this.exemplar(),
    });
  }

  /** Обновляет bounded projection/consumer lag gauges. */
  setLag(kind: 'projection' | 'consumer', name: string, value: number): void {
    const bounded = this.boundedComponent(name);
    if (kind === 'projection') this.projectionLag.set({ projection: bounded }, value);
    else this.consumerLag.set({ consumer: bounded }, value);
  }

  /**
   * Обновляет USE utilization/saturation для runtime, DB pool или consumer.
   * Значения нормализуются в диапазон 0..1, а неизвестный resource объединяется
   * в `unknown`, предотвращая cardinality growth из connection names.
   */
  setResource(resource: string, utilization: number, saturation: number): void {
    const bounded = this.boundedComponent(resource);
    this.resourceUtilization.set({ resource: bounded }, Math.max(0, Math.min(1, utilization)));
    this.resourceSaturation.set({ resource: bounded }, Math.max(0, Math.min(1, saturation)));
  }

  /** Учитывает USE error signal зависимости. */
  resourceFailed(resource: string, reason = 'dependency'): void {
    this.resourceErrors.inc({
      labels: {
        resource: this.boundedComponent(resource),
        reason: this.boundedReason(reason),
      },
      exemplarLabels: this.exemplar(),
    });
  }

  /** Экспортер сообщает отказ internal metric, не бросая ошибку в business flow. */
  exporterFailed(signal: 'traces' | 'metrics', reason: string): void {
    this.exporterFailures.inc({
      labels: { signal, reason: this.boundedReason(reason) },
      exemplarLabels: this.exemplar(),
    });
  }

  /** Учитывает telemetry, отброшенную bounded queue/cardinality guard. */
  telemetryDropped(signal: 'traces' | 'metrics', reason: string): void {
    this.dropped.inc({
      labels: { signal, reason: this.boundedReason(reason) },
      exemplarLabels: this.exemplar(),
    });
  }

  /**
   * Возвращает OpenMetrics exposition для scraper endpoint.
   * Перед сериализацией вычисляется текущая market-data freshness. Метод не
   * обращается к Prometheus и работает даже при полном observability blackout.
   */
  render(): Promise<string> {
    const now = Date.now();
    for (const [channel, publishedAt] of this.lastMarketDataAt) {
      this.marketDataFreshness.set({ channel }, (now - publishedAt) / 1000);
    }
    return this.registry.metrics();
  }

  /**
   * Освобождает registry при shutdown/Jest teardown.
   * Очистка касается только telemetry instruments и не затрагивает audit или
   * доменные idempotency records.
   */
  onModuleDestroy(): void {
    this.registry.clear();
  }

  /** Создаёт counter строго по allow-list labels. */
  private counter(name: MetricName): Counter<string> {
    return new Counter({
      name,
      help: `${name} — operational signal.`,
      labelNames: [...METRIC_LABEL_POLICY[name]],
      registers: [this.registry],
      enableExemplars: true,
    });
  }

  /** Создаёт gauge строго по allow-list labels. */
  private gauge(name: MetricName): Gauge<string> {
    return new Gauge({
      name,
      help: `${name} — current operational state.`,
      labelNames: [...METRIC_LABEL_POLICY[name]],
      registers: [this.registry],
    });
  }

  /** Создаёт histogram с общим latency bucket contract. */
  private histogram(name: MetricName): Histogram<string> {
    return new Histogram({
      name,
      help: `${name} — latency distribution.`,
      labelNames: [...METRIC_LABEL_POLICY[name]],
      buckets: [...LATENCY_BUCKETS_SECONDS],
      registers: [this.registry],
      enableExemplars: true,
    });
  }

  /** Заменяет ID-подобные сегменты route и ограничивает неизвестные шаблоны. */
  private normalizeRoute(route: string): string {
    const path = route.split('?')[0] ?? '/unknown';
    return path
      .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ':id')
      .replace(/\/[A-Za-z0-9_-]{24,}(?=\/|$)/g, '/:id')
      .slice(0, 128);
  }

  /** Сводит причины к фиксированному каталогу, предотвращая cardinality explosion. */
  private boundedReason(reason: string): string {
    const allowed = new Set([
      'none',
      'validation',
      'authorization',
      'rate_limit',
      'timeout',
      'dependency',
      'invariant',
      'queue_full',
      'export_error',
      'unknown',
    ]);
    return allowed.has(reason) ? reason : 'unknown';
  }

  /** Разрешает только заранее известные low-cardinality resource names. */
  private boundedComponent(value: string): string {
    const allowed = new Set([
      'orders',
      'balances',
      'trades',
      'projection',
      'settlement',
      'event-log',
      'postgres',
      'postgres-pool',
      'event-loop',
      'runtime',
      'market-data',
      'trading',
    ]);
    return allowed.has(value) ? value : 'unknown';
  }

  /** Ограничивает instrument label фиксированным allow-list и other bucket. */
  private boundedInstrument(value: string): string {
    return ['BTC-USD', 'ETH-USD'].includes(value) ? value : 'other';
  }

  /** Связывает sample с trace без создания постоянного high-cardinality label. */
  private exemplar(): Record<string, string> {
    const active = trace.getSpan(context.active())?.spanContext();
    return active && isSpanContextValid(active)
      ? { trace_id: active.traceId, span_id: active.spanId }
      : {};
  }
}
