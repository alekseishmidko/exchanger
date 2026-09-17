# Failure matrix

Статус: active. Последнее обновление: 2026-09-18. Машиночитаемый источник
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
| PostgreSQL network latency/reset/loss | Toxiproxy + bounded netem между application и DB/outbox                  | readiness=503, admission прекращается, recovery bounded          | `PostgresCriticalDependencyUnavailable` | Ledger Platform  | `pnpm resilience:network`                              |
| Pool pressure/deadlock/read-only DB   | table lock, concurrent requests, reverse row locks, database default      | bounded timeout/retry без частичного durable effect              | `PostgresPoolSaturation`                | Ledger Platform  | `pnpm resilience:contention`                           |
| Backend SIGKILL после accepted        | SIGKILL active replica после сохранения public result                     | прежний result, RPO=0, takeover после lease TTL                  | `TradingPartitionRecoveryFailed`        | Trading Core     | `pnpm resilience:process-kill`                         |
| Rolling partition ownership           | stop/start backend A → B → A                                              | один lease, fencing старого owner, sequence без gap              | `TradingPartitionRecoveryFailed`        | Trading Core     | `pnpm resilience:rolling`                              |
| Freeze/circuit breaker под нагрузкой  | freeze/unfreeze и dual-control stop/resume при command loop               | стабильные 409 и восстановление admission                        | `TradingCircuitBreakerOpen`             | Risk Platform    | `pnpm resilience:controls`                             |
| Slow consumer/reconnect storm         | k6 WebSocket profile + bounded receive                                   | disconnect/backpressure без роста matching p99                   | `WebSocketBackpressure`                 | Market Data      | частично покрыто load suite; operational chaos pending |
| Audit tampering                       | изменить копию audit chain                                               | integrity=false, admin writes остановлены                        | `AuditIntegrityViolation`               | Security         | `admin.service.spec.ts`                                |

Остаются отдельными незакрытыми qualification-задачами: настоящий PostgreSQL
primary/standby failover, pressure реального data volume, process kill точно
внутри matching/settlement/projection callback, WebSocket reconnect storm и
resource/OOM qualification. Наличие общего runner не является доказательством
этих сценариев до зелёного artifact конкретного запуска.

## Общий критерий результата

После каждого автоматизированного scenario runner проверяет load thresholds,
duplicate effect, readiness policy, audit integrity и reconciliation. Артефакты
содержат seed, абсолютное время, offset каждого действия и sanitized diagnostics.
Fault никогда не исправляет event/audit history на месте: восстановление возможно
только replay, retry или компенсирующей операцией.
