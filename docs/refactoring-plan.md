# Ступенчатый рефакторинг для снижения когнитивной нагрузки

## Цель

Рефакторинг выполняется маленькими проверяемыми шагами. Каждый шаг должен
сохранять публичные контракты и проходить `pnpm lint`, `pnpm typecheck`,
релевантные тесты и business-readiness smoke. Запрещены “комбайн PR”, где
одновременно меняются architecture, поведение и formatting всего проекта.

## Принципы дробления

- Один файл должен иметь одну причину для изменения: transport, application
  policy, domain model, infrastructure adapter или test fixture.
- Controller/gateway не содержит business branching глубже orchestration.
- Domain service не импортирует Nest, HTTP, Swagger, Socket.IO или PostgreSQL.
- Test data builders живут отдельно от сценариев.
- Большой файл сначала покрывается characterization test, потом дробится.
- Имена новых файлов отражают роль: `*.policy.ts`, `*.mapper.ts`,
  `*.repository.ts`, `*.orchestrator.ts`, `*.fixtures.ts`, `*.builders.ts`.

## Текущие кандидаты

Baseline от `pnpm maintainability:report` на момент ввода этапа 20:

- `apps/backend/src/modules/admin/admin.service.ts` — 545 строк;
- `apps/backend/src/modules/market-data/market-data.gateway.ts` — 511 строк;
- `apps/backend/src/modules/observability/metrics.ts` — 428 строк;
- `apps/backend/src/modules/admin/admin.controller.ts` — 408 строк;
- `apps/backend/src/modules/ledger/infrastructure/postgres.int-spec.ts` — 690 строк.

CI уже запускает `MAINTAINABILITY_ENFORCE=true pnpm maintainability:report`
с мягкими лимитами 600 строк для production и 800 строк для test/spec. Это
blocking guard от ухудшения baseline. Финальные строгие лимиты включаются
после закрытия P0/P1 refactor candidates.

| Приоритет | Файл                                             | Почему тяжёлый                                                   | Целевое дробление                                                                            |
| --------- | ------------------------------------------------ | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| P0        | `admin.service.ts`                               | lifecycle, dual-control, policies, reconciliation в одном классе | `admin-command.service`, `dual-control.service`, `policy-registry`, `reconciliation.service` |
| P0        | `market-data.gateway.ts`                         | transport auth, validation, subscription registry, error mapping | `market-data-auth`, `subscription-registry`, `ws-error-mapper`, gateway orchestration        |
| P0        | `metrics.ts` / `tracing.ts`                      | catalog, adapters и policy вместе                                | `metrics-catalog`, `metrics-recorder`, `tracing-context`, exporter config                    |
| P1        | `postgres-ledger.adapter.ts`                     | SQL mapping, transaction orchestration, domain mapping           | repositories per aggregate + mapper                                                          |
| P1        | `projection.ts` / `postgres-projection.store.ts` | apply logic, pagination, rebuild и storage смешаны               | event appliers, pagination policy, rebuild coordinator                                       |
| P1        | `settlement.ts`                                  | reserve, settle, fees, event publish/retry                       | reserve service, posting matrix builder, settlement publisher                                |
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
