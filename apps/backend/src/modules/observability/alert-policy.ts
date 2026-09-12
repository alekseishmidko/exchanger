/**
 * Нормализованный набор сигналов для synthetic alert verification.
 *
 * Поля уже содержат результат PromQL-агрегации и поэтому не включают userId,
 * commandId и другие значения с неограниченной cardinality. Числовые ratio
 * задаются в диапазоне `0..1`, counters и lag — неотрицательными числами.
 */
export type AlertSignals = Readonly<{
  availabilityErrorRatio: number;
  infrastructureRejectionRatio: number;
  settlementInvariantFailures: number;
  reconciliationDifferences: number;
  marketDataSaturation: number;
  marketDataGaps: number;
  projectionLag: number;
  backendUp: boolean;
  telemetryExportFailures: number;
}>;

/** Имена Prometheus alerts, синхронизируемые contract test с alerts.yaml. */
export const ALERT_NAMES = [
  'ExchangeAvailabilitySloBurn',
  'ExchangeCommandAcceptanceDegraded',
  'ExchangeSettlementCorrectnessViolation',
  'ExchangeMarketDataStale',
  'ExchangeProjectionLagHigh',
  'ExchangeTelemetryBlackout',
] as const;

/** Имя проверяемого алерта этапа 15. */
export type AlertName = (typeof ALERT_NAMES)[number];

/**
 * Детерминированная reference policy для synthetic firing/resolved тестов.
 *
 * Prometheus отвечает за окна `for` и rate/increase, а функция проверяет пороги
 * уже вычисленных сигналов. CI подаёт normal/degraded/recovered fixtures в каждый
 * alert и тем самым не оставляет непроверяемый rule после изменения каталога.
 *
 * @param signals Агрегированные значения SLI без временного окна Prometheus.
 * @returns Полная карта alert name → firing state.
 *
 * @example `evaluateAlerts({ ...NORMAL_SIGNALS, projectionLag: 1001 })`
 * вернёт `ExchangeProjectionLagHigh: true`, не изменяя остальные состояния.
 */
export function evaluateAlerts(signals: AlertSignals): Readonly<Record<AlertName, boolean>> {
  return {
    ExchangeAvailabilitySloBurn: signals.availabilityErrorRatio > 0.005,
    ExchangeCommandAcceptanceDegraded: signals.infrastructureRejectionRatio > 0.01,
    ExchangeSettlementCorrectnessViolation:
      signals.settlementInvariantFailures > 0 || signals.reconciliationDifferences > 0,
    ExchangeMarketDataStale: signals.marketDataSaturation > 0.8 || signals.marketDataGaps > 0,
    ExchangeProjectionLagHigh: signals.projectionLag > 1000,
    ExchangeTelemetryBlackout: !signals.backendUp || signals.telemetryExportFailures > 10,
  };
}

/** Baseline fixture: все SLI находятся внутри budget. */
export const NORMAL_SIGNALS: AlertSignals = {
  availabilityErrorRatio: 0,
  infrastructureRejectionRatio: 0,
  settlementInvariantFailures: 0,
  reconciliationDifferences: 0,
  marketDataSaturation: 0.2,
  marketDataGaps: 0,
  projectionLag: 0,
  backendUp: true,
  telemetryExportFailures: 0,
};
