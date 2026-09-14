/**
 * Версионируемый каталог chaos-сценариев и их фактической готовности.
 *
 * `automated` означает, что сценарий выполняется текущим runner. `component`
 * покрывается детерминированным Jest-набором. `blocked` запрещает выдавать
 * зелёный operational gate до появления реального infrastructure adapter.
 */
export const CHAOS_SCENARIOS = Object.freeze([
  {
    id: 'observability-outage',
    status: 'automated',
    dependency: 'OpenTelemetry/Prometheus/Tempo/Grafana',
    injection: 'docker compose stop/start observability services под k6 workload',
    expected: 'business flow и readiness доступны; telemetry восстанавливается bounded',
    alert: 'ObservabilityPipelineUnavailable',
    owner: 'platform',
  },
  {
    id: 'event-log-consumer-faults',
    status: 'component',
    dependency: 'in-memory event log',
    injection: 'deterministic timeout/crash/duplicate/poison event',
    expected: 'exactly-once effect, DLQ и уменьшающийся backlog',
    alert: 'EventConsumerLagHigh',
    owner: 'trading-platform',
  },
  {
    id: 'sequencer-recovery',
    status: 'component',
    dependency: 'trading state machine',
    injection: 'snapshot restart, gap, duplicate, pause/resume и fixed clock',
    expected: 'monotonic sequence и прежний duplicate result',
    alert: 'TradingSequenceGap',
    owner: 'trading-core',
  },
  {
    id: 'postgres-network-faults',
    status: 'blocked',
    dependency: 'PostgreSQL production adapter',
    injection: 'Toxiproxy latency/timeout/reset/packet loss',
    expected: 'readiness unavailable и безопасная остановка admission',
    alert: 'PostgresCriticalDependencyUnavailable',
    owner: 'ledger-platform',
    blockedBy: 'development runtime не подключает PostgreSQL adapter',
  },
  {
    id: 'postgres-contention',
    status: 'blocked',
    dependency: 'PostgreSQL production adapter',
    injection: 'pool exhaustion/deadlock/lock contention/read-only transaction',
    expected: 'bounded timeout/retry без нарушения ledger invariants',
    alert: 'PostgresPoolSaturation',
    owner: 'ledger-platform',
    blockedBy: 'development runtime не подключает PostgreSQL adapter',
  },
  {
    id: 'durable-process-kill',
    status: 'blocked',
    dependency: 'durable command/event log and snapshots',
    injection: 'SIGKILL backend во время accepted command',
    expected: 'RPO=0 и replay до прежнего sequence',
    alert: 'TradingPartitionRecoveryFailed',
    owner: 'trading-core',
    blockedBy: 'reference runtime хранит command state только в памяти',
  },
]);

/** Возвращает сценарий по стабильному идентификатору. */
export function chaosScenario(id) {
  return CHAOS_SCENARIOS.find((scenario) => scenario.id === id);
}
