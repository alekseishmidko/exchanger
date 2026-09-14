# Failure matrix

Статус: active. Последнее обновление: 2026-09-15. Машиночитаемый источник
готовности сценариев — `tests/chaos/scenarios.mjs`.

| Boundary / отказ                      | Injection method                                                         | Ожидаемое поведение                                              | Alert                                   | Owner            | Автоматизация                                          |
| ------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------- | --------------------------------------- | ---------------- | ------------------------------------------------------ |
| Invalid environment                   | удалить обязательное значение в test process                             | startup blocked до bind порта                                    | `ApplicationStartupFailure`             | Backend          | `environment.spec.ts`                                  |
| Observability outage                  | остановить Collector, Tempo, Prometheus, Alertmanager и Grafana под k6   | business flow/readiness продолжаются, exporter bounded           | `ObservabilityPipelineUnavailable`      | Platform         | `pnpm chaos:observability`                             |
| Event-log append timeout              | deterministic `failNext`                                                 | неуспешный append не принят; retry создаёт одно событие          | `EventLogAppendFailures`                | Trading Platform | `resilience-chaos.spec.ts`                             |
| Consumer crash до offset commit       | handler применяет idempotent effect и падает один раз                    | redelivery без второго business effect                           | `EventConsumerLagHigh`                  | Trading Platform | `resilience-chaos.spec.ts`                             |
| Poison event                          | handler стабильно падает до retry limit                                  | DLQ, offset движется, следующий event обработан                  | `EventDeadLetterCreated`                | Trading Platform | `resilience-chaos.spec.ts`                             |
| Sequence gap/restart                  | gap command и restore snapshot                                           | admission blocked на gap; duplicate возвращает прежний result    | `TradingSequenceGap`                    | Trading Core     | `resilience-chaos.spec.ts`                             |
| Projection gap                        | доставить sequence N+1 перед N                                           | projection не меняется до упорядоченного replay                  | `ProjectionGapDetected`                 | Query Platform   | `resilience-chaos.spec.ts`                             |
| Ledger duplicate                      | повторить reservation operation ID                                       | нет второй reservation/posting, reconciliation сходится          | `LedgerInvariantViolation`              | Ledger           | `resilience-chaos.spec.ts`                             |
| PostgreSQL network latency/reset/loss | Toxiproxy между application и DB                                         | readiness=503, admission прекращается либо bounded degraded mode | `PostgresCriticalDependencyUnavailable` | Ledger Platform  | **blocked:** runtime не использует PostgreSQL adapter  |
| Pool exhaustion/deadlock/read-only DB | ограничить pool, conflicting transactions, default_transaction_read_only | bounded timeout/retry без частичного posting set                 | `PostgresPoolSaturation`                | Ledger Platform  | **blocked:** runtime не использует PostgreSQL adapter  |
| Backend SIGKILL после accepted        | kill container по timeline marker                                        | durable replay, RPO=0, monotonic sequence                        | `TradingPartitionRecoveryFailed`        | Trading Core     | **blocked:** command state in-memory                   |
| Slow consumer/reconnect storm         | k6 WebSocket profile + bounded receive                                   | disconnect/backpressure без роста matching p99                   | `WebSocketBackpressure`                 | Market Data      | частично покрыто load suite; operational chaos pending |
| Audit tampering                       | изменить копию audit chain                                               | integrity=false, admin writes остановлены                        | `AuditIntegrityViolation`               | Security         | `admin.service.spec.ts`                                |

`blocked` — это обязательный красный флаг архитектурной готовности, а не
пропущенный тест. Такие строки нельзя переводить в `automated`, пока composition
root действительно не использует соответствующую durable dependency.

## Общий критерий результата

После каждого автоматизированного scenario runner проверяет load thresholds,
duplicate effect, readiness policy, audit integrity и reconciliation. Артефакты
содержат seed, абсолютное время, offset каждого действия и sanitized diagnostics.
Fault никогда не исправляет event/audit history на месте: восстановление возможно
только replay, retry или компенсирующей операцией.
