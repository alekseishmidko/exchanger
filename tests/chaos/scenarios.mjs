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
    status: 'staging',
    dependency: 'PostgreSQL transactional outbox через Toxiproxy',
    injection: 'Toxiproxy latency/bandwidth/timeout/reset/disconnect и bounded netem packet loss',
    expected: 'readiness unavailable и безопасная остановка admission',
    alert: 'PostgresCriticalDependencyUnavailable',
    owner: 'ledger-platform',
  },
  {
    id: 'postgres-contention',
    status: 'staging',
    dependency: 'PostgreSQL production adapter',
    injection: 'pool exhaustion/deadlock/lock contention/read-only transaction',
    expected: 'bounded timeout/retry без нарушения ledger invariants',
    alert: 'PostgresPoolSaturation',
    owner: 'ledger-platform',
  },
  {
    id: 'postgres-failover',
    status: 'staging',
    dependency: 'PostgreSQL physical primary/standby через Toxiproxy',
    injection: 'stop primary, pg_ctl promote standby и atomic proxy upstream switch',
    expected: 'RPO=0, прежний idempotent result и bounded write-path recovery',
    alert: 'PostgresCriticalDependencyUnavailable',
    owner: 'ledger-platform',
  },
  {
    id: 'resource-pressure',
    status: 'staging',
    dependency: 'backend replicas и container runtime limits',
    injection: 'bounded CPU/memory workers, low nofile и Docker freezer event-loop stall',
    expected: 'контролируемая деградация, recovery и reconciliation без corruption',
    alert: 'RuntimeResourceSaturation',
    owner: 'platform',
  },
  {
    id: 'durable-process-kill',
    status: 'staging',
    dependency: 'durable command/event log and snapshots',
    injection: 'SIGKILL backend во время accepted command',
    expected: 'RPO=0 и replay до прежнего sequence',
    alert: 'TradingPartitionRecoveryFailed',
    owner: 'trading-core',
  },
  {
    id: 'rolling-ownership',
    status: 'staging',
    dependency: 'две backend replicas и PostgreSQL lease store',
    injection: 'последовательный stop/start active owner A → B → A',
    expected: 'один active lease, возрастающий fencing epoch и sequence без gap',
    alert: 'TradingPartitionRecoveryFailed',
    owner: 'trading-core',
  },
  {
    id: 'controls-under-load',
    status: 'staging',
    dependency: 'durable admission control',
    injection: 'freeze/unfreeze и dual-control stop/resume под command workload',
    expected: 'стабильный rejection во время control и восстановление admission',
    alert: 'TradingCircuitBreakerOpen',
    owner: 'risk-platform',
  },
]);

/** Возвращает сценарий по стабильному идентификатору. */
export function chaosScenario(id) {
  return CHAOS_SCENARIOS.find((scenario) => scenario.id === id);
}
