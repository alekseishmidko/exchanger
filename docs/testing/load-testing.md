# Реалистичное нагрузочное тестирование

## Статус и область доказательства

Основной runner — **Grafana k6 2.1.0**, закреплённый Docker image. Набор проверяет
реальный HTTP и WebSocket transport через отдельный контейнер-генератор, RED/USE
сигналы, идемпотентные повторы, query visibility и post-load audit
reconciliation. k6 выбран из-за сценарных executors, native thresholds,
OpenMetrics-интеграции и ненулевого exit code при нарушении budget.

Текущий backend использует `InMemoryTradingCommandPort`, который принимает
place/cancel, но не выполняет matching и settlement. Ledger и event log runtime
также являются reference in-memory adapters. Поэтому текущий набор **не
доказывает** PostgreSQL/event-log durability, accepted-to-settled latency,
отсутствие потерянных settlement effects и production SLA. Эти проверки
включаются только после подключения infrastructure adapters; до этого gate этапа
16 остаётся открытым.

## Структура набора

- `tests/load/main.js` — REST/Socket.IO workload, custom metrics и thresholds;
- `tests/load/lib/profiles.js` — smoke, average, stress, spike, soak, breakpoint;
- `tests/load/lib/data.js` — deterministic builders и распределения данных;
- `tests/load/lib/http.js` — единые HTTP headers, timeout и metric names;
- `tests/load/baselines/ci-budget.json` — версионируемый CI regression budget;
- `docker-compose.load.yml` — отдельный k6-контейнер в сети SUT;
- `scripts/run-load-test.mjs` — запуск, metadata, baseline и post-load checks;
- `scripts/check-load-suite.mjs` — статический контракт набора для обычного CI.

Generated output сохраняется в ignored-каталог `artifacts/load/<runId>/`. API
keys, authorization headers и response payloads в metadata и отчёты не
записываются. Wrapper передаёт текущие числовые UID/GID в Compose, поэтому процесс
k6 работает от имени владельца host-каталога. Дополнительно только уникальный
runId-каталог получает права на запись как fallback для Docker-окружений без
POSIX UID API. Это устраняет `permission denied` на Linux/GitHub Actions и не
меняет права исходного дерева проекта.

## Команды запуска

Для локального smoke-теста достаточно Docker и одной команды:

```bash
pnpm load:smoke
```

Остальные профили запускаются аналогично:

```bash
pnpm load:average
pnpm load:stress
pnpm load:spike
pnpm load:soak
pnpm load:breakpoint
```

По умолчанию wrapper поднимает backend, Collector, Tempo, Prometheus,
Alertmanager и Grafana, запускает k6 в отдельном контейнере и удаляет окружение.
Для исследования после теста используется `LOAD_KEEP_ENV=true`. Если staging SUT
уже работает, задаются `LOAD_MANAGE_SUT=false`, HTTPS/WSS endpoints и секреты
через CI secret store:

```bash
LOAD_MANAGE_SUT=false \
LOAD_BASE_URL=https://staging.exchange.example.com \
LOAD_WS_URL=wss://staging.exchange.example.com \
LOAD_HOST_BASE_URL=https://staging.exchange.example.com \
LOAD_API_KEY="$LOAD_API_KEY" \
LOAD_ADMIN_API_KEY="$LOAD_ADMIN_API_KEY" \
pnpm load:stress
```

Runner не принимает произвольное имя профиля. `LOAD_DURATION=15s` разрешён для
короткого CI-прогона, но не должен применяться к release baseline. Для него
используется отдельный throughput guard: k6 вычисляет `Counter.rate` по всему wall
time, а readiness setup и пятисекундный offset WebSocket непропорционально велики
для теста длительностью 10–15 секунд. Полные профили сохраняют целевые thresholds.

## Формы нагрузки

| Профиль    | Назначение                       | REST            | WebSocket   |
| ---------- | -------------------------------- | --------------- | ----------- |
| smoke      | проверка запуска и контрактов    | 1 req/s, 15 s   | 1 VU        |
| average    | ожидаемая обычная нагрузка       | 20 req/s, 2 min | 25 VU       |
| stress     | контролируемое превышение target | до 100 req/s    | до 250 VU   |
| spike      | резкий burst и восстановление    | 10 → 300 req/s  | 10 → 500 VU |
| soak       | утечки памяти/соединений         | 30 req/s, 2 h   | 100 VU, 2 h |
| breakpoint | поиск границы насыщения          | до 1000 req/s   | до 1000 VU  |

`LOAD_DISTRIBUTION=hot` направляет 80% команд в `BTC-USD`; значение `uniform`
равномерно распределяет четыре инструмента. Оба варианта прогоняются перед
release, потому что первый нагружает одну sequencer partition, а второй — routing
и общую инфраструктуру.

Модель заявок: около 85% LIMIT, 15% MARKET; BUY/SELL близки к 50/50; GTC — 80%,
IOC — 15%, FOK — 5%. Размеры берутся из фиксированного распределения от `0.01` до
`5`. Каждая десятая итерация отправляет SELL 1 и две встречные BUY 0.4/0.6,
создавая форму partial/multi-fill для настоящего trading adapter. Каждая пятая
обычная команда отменяется. Каждая двадцатая повторяется с тем же idempotency key
и обязана вернуть побайтно тот же публичный результат.

Socket.IO тестируется по Engine.IO v4 wire protocol. Сессии чередуют public ticker
и private user subscriptions, проверяют namespace handshake/ack и регулярно
закрываются, моделируя reconnect. Private запрос всегда содержит identity,
совпадающую с principal API key.

## Данные и изоляция

Идентификатор строится из `runId`, scenario, VU и iteration. Он уникален между
параллельными генераторами и остаётся детерминированным внутри одного replay.
Staging dataset должен находиться в отдельном tenant/schema, помеченном runId.
Автоматическое удаление разрешено только для такого tenant; production database
запрещена политикой запуска.

Сейчас reference Gateway проверяет object ownership относительно `dev-user`,
поэтому локальный контур использует `LOAD_ACCOUNT_ID=dev-user`. После подключения
durable adapters setup обязан создать отдельные accounts/assets через application
API и cleanup — архивировать результаты и удалить только test tenant.

## Thresholds и измерения

| Сигнал                              |                           Budget |
| ----------------------------------- | -------------------------------: |
| checks                              |                            > 99% |
| HTTP errors                         |                             < 1% |
| timeout rate                        |                           < 0.5% |
| HTTP p50 / p95 / p99 / max          |      < 100 / 300 / 800 / 5000 ms |
| accepted command throughput         | > 0.5/s smoke; профильный budget |
| accepted-to-visible p95 / p99 / max |          < 1000 / 2000 / 5000 ms |
| WebSocket handshake+ack             |                            > 99% |
| duplicate business result           |                    0 расхождений |

Threshold failure приводит к ненулевому коду k6 и падению pipeline. Summary
дополнительно сравнивается с `ci-budget.json`; допустимый процент регрессии
хранится рядом с baseline. Стартовый файл является budget, а не измеренным
production baseline. Настоящий baseline принимается только после трёх прогонов на
одинаковых hardware, topology, dataset и configuration.

Prometheus endpoint после нагрузки проверяется на CPU, memory и event-loop
метрики. Raw OpenMetrics snapshot, k6 points, aggregate JSON, Markdown summary,
run metadata и SVG latency trend сохраняются как CI artifacts. После подключения
PostgreSQL exporter обязательны pool usage, active connections, locks, deadlocks,
I/O и network throughput; отсутствие этих сигналов пока оставляет соответствующий
пункт чеклиста открытым.

Accepted-to-visible измеряется от HTTP 201 до появления order ID в query API.
Поиск выполняется в pagination-окне около детерминированной позиции iteration,
поэтому рост истории больше 100 записей не создаёт ложный failure первой страницы.
Accepted-to-settled должен измеряться по correlation/command metadata до
`SettlementApplied`, а не по длительности HTTP. Эта метрика намеренно не
эмулируется на reference command port.

## Post-load проверки

Wrapper после k6:

1. запрашивает admin reconciliation и требует `auditIntegrity=true`;
2. сохраняет projection schema/lag;
3. проверяет наличие runtime metrics;
4. сравнивает latency/error aggregate с baseline budget;
5. создаёт `report.json`, `summary.md` и `latency-trend.svg`.

Полный gate дополнительно обязан сверить accepted commands, `TradeExecuted`,
`SettlementApplied`, ledger operations и projection rows по runId:

```text
accepted trades = unique TradeExecuted = unique SettlementApplied
ledger business effects per trade = 1
projection visible sequence >= final committed event offset
reconciliation differences = 0
```

Эта проверка не может быть отмечена выполненной до появления durable runtime
adapters и queryable runId/correlation metadata.

## CI, schedule и результаты

Pull request запускает сокращённые smoke/average jobs. Stress и soak запускаются
workflow `Realistic load profiles` по расписанию и при публикации release. Raw
results загружаются независимо от успеха thresholds, а `summary.md` добавляется в
GitHub Step Summary.

Каждый `report.json` содержит дату, build SHA, признак dirty working tree, environment, профиль,
распределение, CPU model/count, память генератора, topology и dataset policy.
Ссылка на GitHub artifact добавляется интерфейсом Actions к конкретному run.

## Известные bottlenecks и владельцы

| Ограничение                                     | Риск                                                   | Владелец        | План устранения                                    |
| ----------------------------------------------- | ------------------------------------------------------ | --------------- | -------------------------------------------------- |
| In-memory command port не выполняет matching    | multi-fill не создаёт trades                           | Trading         | подключить sequencer/matching application adapter  |
| In-memory ledger/event log                      | durability и DB lock profile не измеряются             | Ledger/Platform | PostgreSQL repository и durable event-log adapter  |
| Fixed-window limiter локален процессу           | профиль нескольких реплик неточен                      | Gateway         | общий distributed rate-limit store и пул test keys |
| matching сортирует opposite orders `O(n log n)` | рост p99 на глубоком стакане                           | Trading         | ordered price-level structure без изменения replay |
| Socket.IO session короткая                      | долгоживущая connection memory проверяется только soak | Market Data     | анализ heap/connection churn по soak artifacts     |

Новый bottleneck записывается с owner, issue/ADR и сравнением до/после. Повышать
threshold для скрытия регрессии без такого решения запрещено.

## Pilot baseline и production SLA

Pilot baseline из `pilot-performance.md` измеряет чистые in-process алгоритмы без
сети и БД. Этот k6-набор измеряет transport и runtime под параллелизмом, но до
подключения durable adapters всё ещё не является production SLA. Production SLO
принимается только на staging topology, эквивалентной production, с TLS,
отдельными load generators и доказанным post-load financial reconciliation.
