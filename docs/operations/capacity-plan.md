# Capacity plan и production-readiness qualification

## Назначение

Этот документ задаёт порядок capacity qualification перед production release.
Он не заменяет фактические load/chaos отчёты: release допускается только после
прогона на release-candidate окружении с сохранёнными artifacts, build SHA,
topology, resource limits и решением go/no-go.

## Production target и headroom

| Контур                 |              Average target |            Peak target |               Минимальный headroom | N+1 / отказ instance                      |
| ---------------------- | --------------------------: | ---------------------: | ---------------------------------: | ----------------------------------------- |
| REST command/query API | определяется release report |           ≥ 2x average |        p95/p99 в SLO при CPU ≤ 60% | выдержать потерю 1 backend replica        |
| WebSocket fan-out      | определяется release report |  ≥ 2x average sessions | send buffer без backpressure storm | reconnect storm не влияет на matching p99 |
| Sequencer/matching     |          per hot instrument |    peak hot instrument |    queue не растёт дольше 1 минуты | ownership transfer без двух writers       |
| Settlement/ledger      |         accepted trade rate |        peak fill burst |      accepted-to-settled p99 ≤ 2 s | consumer catch-up после restart           |
| Projections            |           source event rate |   rebuild + live apply |                   lag ≤ SLO budget | shadow rebuild/swap без data leak         |
| PostgreSQL/outbox      |      write TPS + WAL growth | peak + failover replay |   connections < 70%, locks bounded | RPO=0 для accepted command                |

До появления измеренного production baseline эти значения являются qualification
target, а не доказанным SLA. Первый release-candidate report должен заменить
плейсхолдеры фактическими throughput, latency и saturation numbers.

## Что измеряется

| Измерение                        | Профиль                                     | Evidence                                 | Gate                                          |
| -------------------------------- | ------------------------------------------- | ---------------------------------------- | --------------------------------------------- |
| Maximum sustainable throughput   | `load:breakpoint` или staging k6            | `artifacts/load/**/report.json`          | saturation point найден до отказа инвариантов |
| Average/peak SLO                 | `load:average`, `load:stress`, `load:spike` | k6 summary, metrics snapshot             | p50/p95/p99 и error rate в budget             |
| Soak leaks                       | `load:soak`                                 | memory/handles/GC/pool trends            | нет монотонного роста после warm-up           |
| Instrument/account/history scale | dedicated seeded dataset                    | dataset metadata + projection lag        | latency растёт в согласованной модели         |
| PostgreSQL capacity              | staging SQL/WAL/index report                | connection, lock, WAL, storage artifacts | нет pool starvation/deadlock outside policy   |
| Scale-out/in                     | durable staging resilience                  | lease/fencing timeline                   | один active owner, monotonic sequence         |
| Graceful shutdown                | rolling/resilience suite                    | accepted work and offsets report         | accepted work завершено или восстановлено     |
| Deploy/rollback compatibility    | migration + RC rollback rehearsal           | schema/version report                    | clients/events предыдущей версии совместимы   |
| Telemetry cost                   | observability volume report                 | series/spans/log bytes/day               | retention cost accepted                       |

## Causal autoscaling policy

Autoscaling не должен опираться только на средний CPU. Минимальный набор
causal-сигналов:

- REST: request rate, p95/p99, timeout rate, rate-limit pressure.
- Sequencer: queue depth, wait time, owner lease renew latency, hot partition.
- Matching: commands/sec per instrument, active orders, match loop latency.
- Settlement/event log: consumer lag, retry count, DLQ, outbox publish delay.
- Ledger/PostgreSQL: active connections, lock wait, deadlocks, WAL growth.
- Projections: source-high-watermark minus committed offset, rebuild progress.
- WebSocket: active sessions, outbound queue, disconnect/reconnect rate.

Scale-out запрещён, если новый instance не может получить fencing/ownership
lease или если readiness не подтверждает доступность durable dependencies.
Scale-in использует graceful shutdown: закрыть admission, дождаться in-flight
work или durable handoff, зафиксировать offsets и освободить lease.

## Capacity dimensions

Каждый release-candidate report обязан фиксировать влияние:

- числа instruments и доли hot instrument traffic;
- active orders per instrument и глубины price levels;
- accounts/balances count и ledger posting growth;
- event history size, WAL/archive retention и restore throughput;
- projection table size, indexes и rebuild duration;
- WebSocket public/private subscription mix;
- telemetry cardinality, logs volume и trace sampling.

## Cost model

Cost estimate хранится в release report и минимум содержит:

- backend replicas, PostgreSQL/storage/WAL/archive, observability backend;
- traffic profile: average, peak, soak retention;
- telemetry ingestion: logs GB/day, metrics series, traces spans/day;
- headroom premium для burst и отказа одного instance/node;
- owner, дата пересмотра и ссылка на baseline/trend.

## Owners

| Область                          | Owner                           | Решение                            |
| -------------------------------- | ------------------------------- | ---------------------------------- |
| SLO/error budget                 | Platform + владельцы capability | остановка rollout при budget burn  |
| Capacity/load                    | Platform                        | acceptance нагрузочных профилей    |
| Trading ownership/order          | Trading Core                    | go/no-go для sequencer/matching    |
| Ledger/settlement/reconciliation | Ledger Platform                 | go/no-go по финансовым инвариантам |
| Market data/WebSocket            | Market Data                     | fan-out/reconnect acceptance       |
| Security/API threat model        | Security Owner                  | risk acceptance или блок release   |
| Release decision                 | Release Manager                 | финальное go/no-go                 |

## Baseline и trend

Baseline считается принятым только после трёх сопоставимых прогонов на одной
topology без unexplained regression. Trend history ведётся в
`docs/operations/capacity-trends.md` и ссылается на artifacts, build SHA и
release report. Стартовый `tests/load/baselines/ci-budget.json` остаётся CI
guard и не является production baseline.
