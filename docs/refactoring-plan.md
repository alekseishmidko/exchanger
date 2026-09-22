# Ступенчатый рефакторинг для снижения когнитивной нагрузки

## Цель

Рефакторинг выполняется маленькими проверяемыми шагами. Каждый шаг должен
сохранять публичные контракты и проходить `pnpm lint`, `pnpm typecheck`,
релевантные тесты и business-readiness smoke. Запрещены “комбайн PR”, где
одновременно меняются architecture, поведение и formatting всего проекта.

## Принципы дробления

- Один файл должен иметь одну причину для изменения: transport, application
  policy, domain model, infrastructure adapter или test fixture.
- Модуль организуется семантическими папками, когда в нём появляется больше
  одной роли файлов: `domain/`, `application/`, `ports/`, `dto/`, `types/`,
  `infrastructure/`, `controllers/`, `policies/`, `mappers/`, `repositories/`,
  `fixtures/` или `builders/`.
- `index.ts` остаётся публичным API модуля; соседние модули не делают deep
  imports в семантические подпапки без отдельного architectural exception.
- Controller/gateway не содержит business branching глубже orchestration.
- Domain service не импортирует Nest, HTTP, Swagger, Socket.IO или PostgreSQL.
- Test data builders живут отдельно от сценариев.
- Большой файл сначала покрывается characterization test, потом дробится.
- Имена новых файлов отражают роль: `*.policy.ts`, `*.mapper.ts`,
  `*.repository.ts`, `*.orchestrator.ts`, `*.fixtures.ts`, `*.builders.ts`.

## Текущие кандидаты

Baseline от `pnpm maintainability:report` на момент ввода этапа 20:

- `apps/backend/src/modules/admin/admin.service.ts` — 545 строк;
- `apps/backend/src/modules/market-data/gateways/market-data.gateway.ts` — transport orchestration;
- `apps/backend/src/modules/observability/metrics/metrics.ts` — Prometheus registry;
- `apps/backend/src/modules/admin/admin.controller.ts` — 408 строк;
- `apps/backend/src/modules/ledger/infrastructure/postgres.int-spec.ts` — 690 строк.

CI уже запускает `MAINTAINABILITY_ENFORCE=true pnpm maintainability:report`
с мягкими лимитами 600 строк для production и 800 строк для test/spec. Это
blocking guard от ухудшения baseline. Финальные строгие лимиты включаются
после закрытия P0/P1 refactor candidates.

Текущий прогресс:

- `admin` переведён на семантическую структуру `controllers/`, `dto/`,
  `types/`, `policies/`, `ports/` и `infrastructure/`;
- `admin.service.ts` раздроблен на `types/admin.types.ts`,
  `policies/admin-command.policy.ts` и
  `policies/admin-policy-registry.service.ts`;
- `gateway` переведён на семантическую структуру `controllers/`, `dto/`,
  `validation/`, `auth/`, `ports/`, `types/`, `application/` и
  `infrastructure/`;
- для control-plane создан `admin/admission-control.ts`, чтобы Gateway и Health
  зависели от admission sub-boundary, а не от полного `AdminModule`;
- `market-data.websocket.e2e-spec.ts` разгружен через
  `test/builders/market-data-builders.ts`: вынесены Socket.IO helpers, envelope
  ожидания, test API keys и common subscribe/heartbeat payloads;
- `audit` переведён на семантическую структуру `domain/`, `ports/` и
  `infrastructure/` с сохранением публичного barrel API;
- `ledger` переведён на семантическую структуру `controllers/`, `dto/`,
  `application/`, `ports/`, `domain/` и `infrastructure/` с сохранением
  публичного barrel API `../ledger`;
- `projections` переведён на семантическую структуру `controllers/`, `dto/`,
  `types/`, `ports/`, `application/` и `infrastructure/`; read-model типы
  вынесены отдельно от in-memory store;
- `projections/infrastructure` разделён на repositories для versions,
  processed events, orders, trades и balances; `PostgresProjectionStore` теперь
  координирует transaction/rebuild, а не держит SQL каждой таблицы;
- `ledger/infrastructure` разделён на repositories для assets, accounts,
  balances, operations, postings и reservations; `PostgresLedgerAdapter` теперь
  координирует atomic ledger mutation и idempotency flow;
- `health` переведён на семантическую структуру `controllers/`, `application/`,
  `ports/` и `types/` с сохранением compatibility alias для
  `CorrelationIdInterceptor`;
- `market-data.gateway.ts` разгружен через semantic helpers: connection policy,
  subscription registry, envelope factory, gateway types и telemetry observer;
- `observability/metrics.ts` разделён на metrics catalog, label policy и
  recording service без изменения публичных exports;
- `market-data` переведён на семантическую структуру `domain/`, `dto/`,
  `gateways/`, `policies/`, `registries/`, `transport/`, `validation/`;
- `observability` переведён на семантическую структуру `logging/`, `metrics/`,
  `tracing/`, `alerts/` с сохранением public barrel `../observability`;
- `market-data` получил `policies/market-data-error.policy.ts`, поэтому
  безопасное WebSocket error mapping отделено от Socket.IO handlers;
- `admin` получил `services/admin-dual-control.service.ts` и
  `services/admin-reconciliation.service.ts`; `AdminService` остался фасадом;
- `settlement` получил `policies/settlement-posting.policy.ts` и
  `mappers/settlement-event.mapper.ts` для posting matrix и event payload
  mapping;
- PostgreSQL durable runtime spec начал использовать
  `test/builders/durable-runtime-builders.ts` для place-order и settlement
  fixtures;
- `AdminService` оставлен публичным фасадом для контроллера и тестов, поэтому
  transport API и imports из `admin.service.ts` не изменились;
- policy registry изолирует fee/risk policy validation и effective-time lookup;
- command policy изолирует role matrix, dual-control decision, result mapping и
  compensation reverse mapping;
- relevant checks: `corepack pnpm --filter @exchange/backend test --
admin.service.spec.ts gateway.spec.ts structured-logger.spec.ts
test/market-data.websocket.e2e-spec.ts src/modules/ledger/ledger.spec.ts
src/modules/projections/projection.spec.ts
--runInBand`,
  `corepack pnpm --filter @exchange/backend typecheck`,
  `corepack pnpm --filter @exchange/backend lint`, `corepack pnpm
maintainability:report`.

| Приоритет | Файл                                             | Почему тяжёлый                                                   | Целевое дробление                                                                            |
| --------- | ------------------------------------------------ | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| P0        | `admin.service.ts`                               | lifecycle, dual-control, policies, reconciliation в одном классе | `admin-command.service`, `dual-control.service`, `policy-registry`, `reconciliation.service` |
| P0        | `market-data/gateways/market-data.gateway.ts`    | transport auth, validation, subscription registry, error mapping | connection policy, subscription registry, envelope и telemetry вынесены; дальше error mapper |
| P0        | `observability/metrics/metrics.ts` / `observability/tracing/tracing.ts` | catalog, adapters и policy вместе                                | metrics catalog/policy вынесены; дальше tracing-context/exporter config                      |
| P1        | `postgres-ledger.adapter.ts`                     | SQL mapping, transaction orchestration, domain mapping           | repositories вынесены; дальше mapper/policy для posting matrix                               |
| P1        | `projection.ts` / `postgres-projection.store.ts` | apply logic, pagination, rebuild и storage смешаны               | repositories вынесены; дальше event appliers, pagination policy, rebuild coordinator         |
| P1        | `settlement.ts`                                  | reserve, settle, fees, event publish/retry                       | posting matrix и event mapper вынесены; дальше reserve service и settlement publisher        |
| P1        | `matching-engine.ts`                             | book state, matching loop, TIF policy                            | order book, price-level queue, execution policy                                              |
| P2        | large e2e specs                                  | сценарий, setup, builders и assertions вместе                    | fixtures/builders + сценарии по бизнес-флоу                                                  |

## Ступени

### Шаг 0. Safety net

- Зафиксировать текущие команды проверки в PR description.
- Прогнать `pnpm maintainability:report`.
- Для файла-кандидата выбрать минимальный relevant test set.
- Не менять public API, DTO, schemas и SQL в этом шаге.

### Шаг 1. Вынос test builders

Цель — уменьшить шум в e2e/spec без изменения production code.

- `test/builders/api-builders.ts` — API key registry, account/order DTO и instrument rules;
- `test/builders/market-data-builders.ts`;
- `test/builders/ledger-builders.ts`;
- shared helpers для `request(app.getHttpServer())`, idempotency headers и API keys.

Первый срез выполнен для `api-flow.e2e-spec.ts` и
`transport-api.e2e-spec.ts`: assertions не менялись, из spec-файлов вынесены
повторяемые API keys, account/order DTO и instrument rules.

Gate: тесты должны остаться эквивалентными по assertions и public responses.

### Шаг 2. Transport orchestration

Разделить Gateway/WebSocket controller на:

- guard/auth helpers;
- DTO validation остаётся declarative;
- mapper HTTP/WS DTO → application command;
- error mapper → safe public response;
- subscription registry отдельно от Socket.IO handlers.

Gate: `pnpm contracts:check && pnpm adversarial:check`.

### Шаг 3. Application services

Вынести policy/orchestration из больших сервисов:

- admin: dual-control, policy versioning, reconciliation;
- settlement: fee calculation, posting matrix, publisher retry;
- projections: event appliers и rebuild coordinator.

Gate: relevant unit tests + `test/system.e2e-spec.ts`.

### Шаг 4. Infrastructure adapters

Дробить PostgreSQL adapters по repositories и mappers:

- SQL row mapper не должен вызывать domain policy;
- transaction boundary остаётся на application adapter;
- migration tests не меняются без отдельного ADR.

Gate: `postgres.int-spec.ts`, backup/restore при изменении schema.

### Шаг 5. Architecture guard

После стабилизации добавить более строгие правила:

- максимальный размер production файла ≤ 300 строк, adapter exception ≤ 450;
- максимальный размер test/spec файла ≤ 500 строк;
- запрет Nest imports в domain folders;
- запрет SQL imports вне infrastructure folders.

До завершения P0/P1 это работает как report, не как blocking gate.

## Definition of Done для каждого рефакторинга

- Нет изменения поведения без отдельного теста и явного changelog.
- Все JSDoc-комментарии для новых public interfaces на русском языке.
- `pnpm lint`, `pnpm typecheck`, relevant tests зелёные.
- `pnpm maintainability:report` не показывает роста top offender без причины.
- Документация модуля обновлена, если изменилась ответственность файла.
