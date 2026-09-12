# SLI, SLO и error budgets

## Назначение

SLO описывают качество, которое видит клиент, а не состояние отдельного pod.
Окно оценки — rolling 30 дней; staging использует те же запросы с меньшим окном
для проверки правил. Planned maintenance исключается только по заранее
зафиксированному change window. Отсутствие трафика не считается 100% успехом:
availability дополняется synthetic probe.

| Capability | SLI | SLO | Latency objective | Владелец |
| --- | --- | --- | --- | --- |
| Availability | доля REST/synthetic запросов без 5xx/timeout | ≥ 99.95% | HTTP p95 ≤ 250 ms, p99 ≤ 500 ms | Platform |
| Command acceptance | принятые корректные place/cancel / все инфраструктурно допустимые команды | ≥ 99.9% | admission p95 ≤ 50 ms, p99 ≤ 100 ms | Trading |
| Settlement correctness | сделки с ровно одним `SettlementApplied` и нулевой reconciliation difference | 100%; бюджет ошибок 0 | accepted-to-settled p99 ≤ 2 s | Ledger |
| Market-data freshness | updates без gap и не старше freshness budget | ≥ 99.9% | publish-to-client p99 ≤ 500 ms | Market Data |
| Projection lag | время с lag ≤ 1 000 событий | ≥ 99.9% | accepted-to-visible p99 ≤ 5 s | Projections |

Client validation, invalid API key и object authorization отказ не уменьшают
availability. Они входят в security/product signal. Rate limit — client error,
пока лимитер доступен и возвращает ожидаемый 429. Dependency timeout, saturation
и invariant violation уменьшают соответствующий SLI.

## Формулы и burn rate

Availability: `1 - rate(5xx + timeout) / rate(all requests)`. Command acceptance
исключает validation errors из denominator и отдельно показывает authorization.
Settlement correctness сравнивает `TradeExecuted`, idempotency record, posting
matrix и `SettlementApplied`. Projection lag равен source high watermark минус
committed projection sequence. Market freshness определяется максимальным
возрастом последнего непрерывного sequence.

Для availability 99.95% месячный error budget составляет около 21.6 минуты.
Critical alert использует быстрый 5-минутный burn, warning — устойчивую деградацию.
Settlement/reconciliation alert срабатывает с первого нарушения: усреднять
финансовый инвариант запрещено.

## Проверка

`pnpm observability:check` синхронизирует каталог правил и synthetic policy.
Production SLO review проводится еженедельно; при израсходовании 50% бюджета до
середины окна feature rollout приостанавливается, при 100% допускаются только
reliability/security изменения.
