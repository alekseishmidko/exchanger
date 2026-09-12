# Dashboards и alerting

## Запуск staging-подобного контура

`pnpm docker:observability` поднимает backend, OpenTelemetry Collector, Tempo,
Prometheus, Alertmanager и Grafana. Backend: `http://localhost:5001`, Prometheus:
`http://localhost:9090`, Alertmanager: `http://localhost:9093`, Grafana:
`http://localhost:3000`. Development credential
Grafana задан только в compose-файле; production обязан получать его из secret
manager. Остановка с volumes: `pnpm docker:observability:down`.

Конфигурация находится в `deploy/observability/`: Collector pipeline, Tempo
retention, Prometheus scrape/rules, Alertmanager routing и Grafana
provisioning/dashboard. Все images
pin по версии. Dashboard `Exchange / SLO Overview` показывает availability,
p50/p95/p99, projection/consumer lag, USE и correctness. Каждый panel имеет
явное состояние no-data, normal threshold и degraded threshold.

## Каталог и ownership

| Alert | Severity | Owner | Первая проверка |
| --- | --- | --- | --- |
| `ExchangeAvailabilitySloBurn` | critical | Platform | HTTP RED, readiness, dependency USE |
| `ExchangeCommandAcceptanceDegraded` | warning | Trading | admission reasons, sequencer saturation |
| `ExchangeSettlementCorrectnessViolation` | critical | Ledger | остановить partition, reconciliation |
| `ExchangeMarketDataStale` | warning | Market Data | fan-out, gap/resync, slow consumers |
| `ExchangeProjectionLagHigh` | warning | Projections | consumer lag, event log, apply latency |
| `ExchangeTelemetryBlackout` | warning | Platform | Collector queue, Tempo/Prometheus storage |

Rule обязан иметь `owner`, `severity`, `runbook_url`, `diagnostic_context`.
Critical page отправляется primary on-call немедленно; warning создаёт Slack/ticket
и эскалируется через 15 минут устойчивой деградации. Financial invariant всегда
critical. Client error без атаки не page-ит команду.

## Synthetic verification

`pnpm observability:check` подаёт normal, fully degraded и recovered fixtures в
reference alert policy: каждый rule обязан перейти resolved → firing → resolved.
Тот же тест сверяет имена с Prometheus YAML и проверяет metadata. Перед релизом в
staging инженер дополнительно использует synthetic traffic и проверяет реальный
Alertmanager route; эта проверка фиксируется в release evidence.

Различайте: client error — ожидаемый 4xx; saturation — исчерпанная очередь/pool;
dependency failure — timeout/5xx внешнего adapter; invariant violation —
несогласованность business state. Последнее нельзя маскировать retry или
усреднением.
