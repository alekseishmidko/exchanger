# Checklist усиления тестов и паритета local/CI

Цель: локально воспроизводить обязательные GitHub checks и отправлять в pull
request только сборку, прошедшую одинаковые проверки в чистом окружении.

Исходная точка аудита от 2026-09-28:

- backend coverage: statements `69.84%`, branches `54.5%`, functions `61.86%`,
  lines `71.39%`;
- полный coverage-run: `55` suites / `224` tests прошли, `4` suites / `25`
  tests были пропущены без Redis/PostgreSQL flags;
- `human-auth.e2e-spec.ts` зависит от порядка: random seed `20260928`
  воспроизводимо ломает `3/8` tests;
- локально использовался Node 24, GitHub Actions использует Node 22;
- frontend test script пока не запускает тесты.

Правило закрытия пункта: изменение кода без автоматической проверки и команды
воспроизведения не считается выполненным.

## P0 — устранить ложные green и flaky-запуски

### Команды и Jest-конфигурация

- [x] Удалить лишний `--` между `pnpm test` и Jest arguments во всех scripts.
- [x] Проверить, что `--runInBand`, `--maxWorkers`, `--testTimeout`, `--randomize`
      и `--seed` отображаются Jest как options, а не как test patterns.
- [x] Добавить команды `test:unit`, `test:component`,
      `test:integration:postgres`, `test:integration:redis`, `test:e2e` и `test:all`.
- [x] Разделить suites через Jest projects/configs; не определять тип теста только
      по наличию environment variable.
- [x] Сделать integration-команды fail-fast при отсутствии Redis/PostgreSQL,
      вместо успешного завершения через `describe.skip`.
- [x] Выводить в отчёт Node/pnpm versions, Jest seed и число
      passed/failed/skipped tests и suites.

Критерии приёмки:

- [x] Ни один обязательный test job не заканчивается успешно при skipped suite.
- [x] Лог подтверждает применение каждого заявленного Jest option.

### Изоляция тестов

- [x] Устранить зависимость `human-auth.e2e-spec.ts` от порядка `it`.
- [x] Каждый auth test создаёт собственных пользователей, sessions и credentials
      либо весь stateful business flow оформлен одним `it`.
- [x] Проверить `transport-api`, `api-flow`, gateway и realtime e2e на общее
      изменяемое состояние.
- [x] Не хранить созданные ID/password/token между независимыми tests.
- [x] Заменить прямое изменение `process.env` helper'ом, который сохраняет и
      восстанавливает исходное значение в `finally`/`afterEach`.
- [x] Создавать новый Nest application fixture на test или гарантированно
      очищать repositories, timers, sockets и subscribers.
- [x] Заменить реальные ожидания `setTimeout` на fake clock там, где тестируется
      время, а не сеть/процесс.
- [x] Использовать детерминированные IDs и timestamps вместо `Date.now()` и
      `Math.random()`.
- [x] Включить randomized component/e2e запуск с печатью seed.

Команда регрессии:

```bash
pnpm --filter @exchange/backend test:e2e \
  src/modules/auth/human-auth.e2e-spec.ts \
  --runInBand --randomize --seed=20260928 --showSeed
```

Критерии приёмки:

- [x] Команда проходит минимум 10 раз с разными seeds.
- [x] Каждый test проходит при отдельном запуске через `-t`.
- [x] Нет открытых handles после диагностического `--detectOpenHandles` запуска.

### Одинаковое окружение local и GitHub

- [x] Зафиксировать Node `22.23.3` в `engines` и `.nvmrc`; GitHub Actions
      читает ту же `.nvmrc`.
- [x] Добавить preflight, завершающий `verify:local` при несовпадении точной
      версии Node.
- [x] Использовать одинаковую версию pnpm из `packageManager` локально и в CI.
- [x] Добавить clean-checkout gate во временном worktree/container без `dist`,
      `coverage`, старых artifacts и локальных caches.
- [x] Выполнять install только с `--frozen-lockfile`.
- [x] Проверить build и tests без существующего `packages/contracts/dist`.
- [x] Сохранять отдельный stdout/stderr log для каждого шага `verify:local`.
- [x] Останавливать зависимые проверки после первой P0-ошибки.
- [x] Загружать отчёты и backend/container logs через GitHub artifacts при
      `failure()` и `cancelled()`.

Критерии приёмки:

- [x] Один документированный command запускает локально тот же обязательный
      pipeline, что и GitHub verify job.
- [x] Этот command проходит в чистом Node 22 container два раза подряд.
- [x] В локальном и GitHub отчёте совпадает перечень обязательных checks.

Команда полного локального gate (после `nvm use`):

```bash
pnpm install --frozen-lockfile
pnpm verify:local
```

Автоматические регрессии P0:

```bash
pnpm test:options
pnpm test:randomized
pnpm clean-checkout:check
pnpm redis:check
POSTGRES_URL=postgresql://... pnpm --filter @exchange/backend test:integration:postgres
```

На контрольном прогоне от 2026-09-28 clean-checkout gate дважды получил
`55/55` backend suites, `224/224` tests, `0` skipped и успешный workspace build
в Node `22.23.3` / pnpm `10.15.0`. Redis gate получил `2/2` suites и `9/9`
tests; PostgreSQL gate — `2/2` suites и `16/16` tests, оба без skipped tests.
Полный локальный gate завершился результатом `26/26`; его раздельные логи и
summary сохранены в `artifacts/backend-checks/verify-c2630436-d3b`.

## P1 — усилить качество и покрытие

### Coverage gate

- [ ] Добавить coverage report в обязательный PR job.
- [ ] Ввести changed-lines coverage не ниже `90%`.
- [ ] Для realtime domain установить branch coverage не ниже `90%`.
- [ ] Для realtime application/adapters начать с `75%` branch coverage и
      повышать threshold после закрытия сценариев ниже.
- [ ] Coverage threshold должен падать, а не только публиковать HTML.
- [ ] Исключать generated/bootstrap files только с документированным основанием.

### Frontend

- [ ] Подключить Vitest, React Testing Library и DOM environment.
- [ ] Заменить `frontend smoke: no unit tests yet` настоящим test command.
- [ ] Покрыть `FRESH -> STALE` с fake clock.
- [ ] Покрыть `CONNECTED -> DISCONNECTED -> reconnect`.
- [ ] Проверить отображение source, provider timestamp и received timestamp.
- [ ] Проверить malformed WebSocket envelope и status/error events.
- [ ] Проверить unsubscribe и отсутствие старой цены после disconnect.
- [ ] Добавить frontend tests и coverage в `verify:local` и PR workflow.

### Contracts и package boundary

- [ ] Добавить positive/negative tests для всех schemas из
      `packages/contracts/src/realtime-market.ts`.
- [ ] Проверить strict rejection неизвестных fields, границы decimal/timestamp,
      ID lengths и subscription limit `1..100`.
- [ ] Добавить compatibility fixtures для старых REST/WS contracts.
- [ ] Добавить built-package consumer test: build/pack contracts и скомпилировать
      минимальный consumer через публичный export `@exchange/contracts`.
- [ ] Проверить, что source mapping в Jest не скрывает ошибку production build.
- [ ] Оставить OpenAPI/AsyncAPI drift tests обязательным merge gate.

## P1 — Twelve Data/realtime test matrix

### Fake upstream HTTP

- [ ] Поднять локальный HTTP fake server вместо замены `global.fetch`.
- [ ] Проверить catalog pagination и окончание pagination.
- [ ] Проверить partial/empty page и duplicate instruments.
- [ ] Проверить `429`, `5xx`, timeout, malformed JSON и invalid schema.
- [ ] Проверить allowlisted endpoints: crypto, forex, stocks, commodities, quote.
- [ ] Проверить невозможность host/path/query override пользовательским input.
- [ ] Проверить отсутствие API key в errors, logs, traces и metrics labels.
- [ ] Проверить ограничение REST bootstrap и отсутствие unbounded concurrency.

### Fake upstream WebSocket

- [ ] Поднять локальный plain WebSocket fake server.
- [ ] Проверить subscribe payload и ограничение количества symbols.
- [ ] Проверить price, heartbeat, malformed и oversized messages.
- [ ] Проверить duplicate/out-of-order ticks и локальную sequence.
- [ ] Проверить disconnect/reconnect, exponential backoff и resubscribe.
- [ ] Проверить partial subscription/entitlement error.
- [ ] Проверить, что reconnect не оживляет stale pre-disconnect quote.
- [ ] Проверить закрытие socket/timers при application shutdown.

### Redis и leader/fencing

- [ ] Запустить единый `QuoteStorePort` contract suite для memory и Redis.
- [ ] Проверить atomic latest, TTL/freshness и concurrent writers.
- [ ] Проверить restart Redis и fail-closed при outage.
- [ ] Запустить два ingest workers и проверить только одного leader.
- [ ] Проверить failover после потери lease.
- [ ] Доказать, что старый fence token больше не может публиковать quote.
- [ ] Проверить Pub/Sub execution/quote events без duplicate delivery effect.

### PostgreSQL

- [ ] Запустить repository contract suite для memory и PostgreSQL catalog.
- [ ] Запустить repository contract suite для realtime execution repository.
- [ ] Проверить migrations на пустой БД и upgrade существующей схемы.
- [ ] Проверить constraints, append-only tables, rollback и concurrency.
- [ ] Проверить catalog threshold: insert/update/deactivate/reject snapshot.
- [ ] Проверить atomic idempotency commit при конкурентных requests.

### Realtime execution/API/WebSocket

- [ ] Покрыть `POST /api/v1/realtime/orders` для BUY и SELL.
- [ ] Покрыть missing, stale, changed и disabled quote/instrument.
- [ ] Покрыть insufficient user funds и insufficient liquidity.
- [ ] Проверить fees, decimal precision, rounding и balanced postings.
- [ ] Проверить identical retry и conflict при изменённом payload.
- [ ] Проверить concurrent retry: один execution и один settlement.
- [ ] Проверить pause/resume kill switch и authorization matrix.
- [ ] Проверить history/detail/reconciliation endpoints.
- [ ] Проверить private execution isolation между двумя users.
- [ ] Проверить subscribe/unsubscribe, malformed request, quota и backpressure.
- [ ] Проверить status transitions: connecting/connected/degraded/follower.

### Полный realtime flow

- [ ] Добавить обязательный E2E:
      `fake Twelve WS -> Redis -> public WS -> realtime order -> PostgreSQL -> ledger -> private event`.
- [ ] Проверить, что execution сохраняет ровно тот quote, который вернулся
      клиенту, включая provider/received timestamps и source.
- [ ] Добавить request counter, доказывающий ноль Twelve Data calls из всех
      публичных handlers.
- [ ] Проверить много downstream subscribers при фиксированном числе upstream
      subscriptions.
- [ ] Проверить reconciliation: каждый `FILLED` имеет quote snapshot и
      сбалансированный settlement.

## P2 — предотвращение повторных проблем

- [ ] Добавить targeted mutation testing для freshness, pricing, idempotency,
      fees и settlement invariants.
- [ ] Добавить property-based tests для decimal, timestamp, mapping и schemas.
- [ ] Каждый исправленный production/CI defect сначала получает regression test.
- [ ] Запретить Jest retries как постоянное решение flaky-теста.
- [ ] Вести flaky-rate по suite, owner и срок исправления quarantine.
- [ ] Nightly запускать critical suites `20–50` раз с разными seeds.
- [ ] Nightly запускать reconnect/failover/chaos и stress/soak profiles.
- [ ] Live Twelve Data smoke сделать только scheduled/manual, с отдельным
      ограниченным key и обязательной redaction.

## Целевые quality gates

### Перед commit — до 60 секунд

- [ ] format check;
- [ ] lint;
- [ ] typecheck;
- [ ] contracts;
- [ ] affected unit/property tests.

### Перед push — до 5 минут

- [ ] clean checkout в Node 22;
- [ ] randomized unit/component tests;
- [ ] PostgreSQL и Redis integration;
- [ ] frontend tests;
- [ ] fake Twelve HTTP/WS contracts;
- [ ] changed-lines coverage.

### Pull request

- [ ] полный parity `verify:local`;
- [ ] отдельные unit/component/integration/e2e jobs;
- [ ] production image build и clean runtime check;
- [ ] API flows и migration tests;
- [ ] coverage/mutation reports;
- [ ] security, SBOM и container checks.

### Staging и production

- [ ] Перед deployment пройти staging migrations, business E2E и realtime
      canary с fake/sandbox upstream.
- [ ] После deployment выполнить только безопасный read-only smoke и bounded
      synthetic flow отдельным test account.
- [ ] Не запускать destructive integration/chaos tests на production.
- [ ] Проверить feature flags, kill switch и rollback procedure.

## Финальный Definition of Done

- [ ] `pnpm test` больше не скрывает обязательные skipped integrations.
- [ ] Randomized tests с опубликованным seed стабильны.
- [ ] Local и GitHub используют Node 22 и один список обязательных commands.
- [ ] Чистый checkout проходит без локального `dist` и caches.
- [ ] Frontend имеет реальные tests.
- [ ] Coverage thresholds являются обязательным merge gate.
- [ ] Полный fake Twelve Data flow проходит локально и в CI.
- [ ] Два последовательных локальных pre-push запуска и GitHub PR checks
      завершаются зелёным без retry или ручной переделки.
