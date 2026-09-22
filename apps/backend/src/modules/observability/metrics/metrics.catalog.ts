import { OpenMetricsContentType, Registry } from 'prom-client';

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
export function createOpenMetricsRegistry(): Registry<OpenMetricsContentType> {
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
