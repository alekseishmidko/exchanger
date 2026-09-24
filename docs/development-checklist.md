# Чеклист разработки проекта

Статус: обязательный рабочий процесс, версия 1.0.

Чеклист применяется к каждой функциональности и каждому модулю. Пункт считается выполненным только при наличии кода, теста и соответствующей документации.

## 0. Правила выполнения

- [ ] Работа ведётся небольшими вертикальными срезами, а не незавершёнными слоями.
- [ ] Перед реализацией определены пользовательские сценарии, инварианты и границы модуля.
- [ ] Для каждой задачи создана отдельная ветка/изменение с понятным назначением.
- [ ] Реализация начинается с теста по TDD: Red → Green → Refactor → Docs.
- [ ] Неизвестные или спорные решения оформлены как `draft` ADR до реализации.
- [ ] Секреты, персональные данные и реальные финансовые интеграции не используются в тренировочном проекте.
- [ ] Работа не считается завершённой без обновления документации.

## 1. Подготовка задачи

### Требования

- [ ] Описана бизнес-цель и пользователь, для которого нужна функция.
- [ ] Определены in-scope и out-of-scope.
- [ ] Описаны основной, альтернативный и ошибочные сценарии.
- [ ] Определены входы, выходы, состояния и переходы.
- [ ] Зафиксированы требования к задержке, доступности и объёму нагрузки.
- [ ] Определены security и privacy требования.
- [ ] Определены требования к аудиту и сроку хранения данных.

### Дизайн

- [ ] Определена ответственность модуля и явно описано, за что он не отвечает.
- [ ] Определены зависимости и запрещённые зависимости.
- [ ] Описаны commands, events, DTO и ошибки.
- [ ] Определены инварианты и правила идемпотентности.
- [ ] Для изменений архитектуры создан или обновлён ADR.
- [ ] Для изменений межмодульного контракта создан план обратной совместимости.
- [ ] Mermaid-схемы обновлены для новых потоков и границ.

## 2. Реализация модуля через TDD

### Шаг 1 — Red

- [ ] Написаны unit-тесты доменных правил до реализации.
- [ ] Написаны тесты успешного сценария.
- [ ] Написаны тесты невалидных входов.
- [ ] Написаны тесты граничных значений.
- [ ] Написаны тесты повторной доставки и idempotency.
- [ ] Написаны тесты конфликтующих операций и изменения состояния.
- [ ] Для алгоритмов и денег добавлены property-based тесты.
- [ ] Для API добавлены contract tests.

### Шаг 2 — Green

- [ ] Реализовано минимальное решение без преждевременной оптимизации.
- [ ] Доменная логика не зависит от NestJS, HTTP, БД или брокера.
- [ ] Денежные значения и количества не используют floating point.
- [ ] Время приходит через абстракцию clock.
- [ ] Ошибки имеют тип, код и документированную стратегию обработки.
- [ ] Все внешние данные проходят runtime validation.
- [ ] Пользовательские и административные права проверяются на сервере.

### Шаг 3 — Refactor

- [ ] Убраны дублирование и неявные зависимости.
- [ ] Сохранены границы модулей и отсутствие deep imports.
- [ ] Проверены конкурентность, порядок событий и повторная обработка.
- [ ] Проверены resource limits: payload, batch, pagination, timeout, rate limit.
- [ ] Убраны чувствительные данные из логов и ошибок.
- [ ] Код проходит форматирование, lint и strict typecheck.

### Шаг 4 — Docs

- [ ] Обновлён `README.md` модуля.
- [ ] Описаны инварианты в `docs/invariants.md` или соответствующем разделе.
- [ ] Описаны flows и добавлены Mermaid-диаграммы.
- [ ] Описаны команды, события, DTO и коды ошибок.
- [ ] Добавлены примеры запросов и ответов без реальных секретов.
- [ ] Обновлён глобальный документ, если изменение системное.
- [ ] ADR обновлён или создан, если изменилось архитектурное решение.

## 3. Security checklist

### Идентичность и доступ

- [ ] Каждый защищённый endpoint требует аутентификацию.
- [ ] Авторизация проверяется на объект и операцию, а не только на роль.
- [ ] API keys имеют scope, срок действия, статус и возможность отзыва.
- [ ] Секреты хранятся только в secret storage/environment и не попадают в Git.
- [ ] Пароли хешируются проверенным адаптивным алгоритмом.
- [ ] MFA и защита сессий применяются там, где это предусмотрено моделью пользователя.
- [ ] Административные и критичные операции требуют усиленной авторизации.

### Входные данные и API

- [ ] Все payload валидируются по схеме и ограничиваются по размеру.
- [ ] Неизвестные или опасные поля не приводят к неожиданным изменениям модели.
- [ ] SQL, command и event injection исключены параметризацией и schema validation.
- [ ] Rate limits настроены отдельно для IP, пользователя, API key и ресурса.
- [ ] Idempotency key используется для write-операций.
- [ ] Replay старой команды невозможно или явно контролируется.
- [ ] CORS, security headers, TLS и WebSocket origin policy настроены по окружению.

### Данные и аудит

- [ ] Чувствительные данные шифруются при передаче и хранении.
- [ ] В логах отсутствуют пароли, токены, приватные ключи и полные платёжные данные.
- [ ] Доступ к персональным и финансовым данным минимален и аудируется.
- [ ] Критичные административные действия неизменяемо записываются.
- [ ] Корректировка данных выполняется компенсирующей операцией, а не удалением истории.
- [ ] Retention и удаление данных документированы.

### Торговые риски

- [ ] Нельзя потратить больше доступного баланса.
- [ ] Резервирование и списание средств идемпотентны.
- [ ] Проверяются максимальный объём, цена, количество и суточные лимиты.
- [ ] Self-trade prevention покрыт тестами.
- [ ] Emergency stop блокирует новые заявки по заданной политике.
- [ ] Повторное событие не создаёт вторую сделку или проводку.
- [ ] Расхождение ledger и проекций обнаруживается reconciliation-проверкой.

## 4. Контракты и события

- [ ] Контракт размещён только в `packages/contracts`.
- [ ] Импорт выполняется только через `@exchange/contracts`.
- [ ] Есть TypeScript-типы и runtime-схема.
- [ ] У сообщения есть `messageId`, `messageType`, `messageVersion`, `sequence`, correlation и causation metadata.
- [ ] Команда описывает намерение, событие — совершившийся факт.
- [ ] Событие содержит данные, необходимые consumer-у для обработки.
- [ ] Проверены old payload, duplicate delivery и unknown optional fields.
- [ ] Breaking change имеет новую версию, ADR, migration plan и contract tests.
- [ ] Определена политика retention и replay для нового события.

## 5. Данные и миграции

- [ ] Определён source of truth для каждого нового поля/состояния.
- [ ] Спроектированы индексы и ограничения целостности.
- [ ] Денежные значения используют целые минимальные единицы или строго заданный NUMERIC.
- [ ] Миграция обратима либо документирована как irreversible.
- [ ] Миграция проверена на пустой и заполненной базе.
- [ ] Проверены lock duration и влияние миграции на доступность.
- [ ] Для новых проекций описаны rebuild/replay процедуры.
- [ ] Удаление и исправление данных не нарушают audit trail.

## 6. Отказы и восстановление

- [ ] Для каждой зависимости определены timeout, retry, backoff и dead-letter policy.
- [ ] Retry безопасен и не создаёт повторную бизнес-операцию.
- [ ] Поведение при недоступности PostgreSQL, event log, cache и projections покрыто тестами.
- [ ] Consumer хранит offset и восстанавливается после перезапуска.
- [ ] Проверены gaps, duplicate events и out-of-date messages.
- [ ] Snapshot создаётся и валидируется checksum/sequence.
- [ ] Replay из snapshot даёт то же состояние, что и обычная обработка.
- [ ] Проверены crash до и после записи критичного события.
- [ ] Описан manual recovery и reconciliation runbook.

## 7. Наблюдаемость

- [ ] В каждом потоке есть `correlationId` и `causationId`.
- [ ] Логи структурированы и не содержат секретов.
- [ ] Есть metrics для throughput, latency, errors, retries, lag и rejected commands.
- [ ] Есть p50/p95/p99 для критических операций.
- [ ] Есть alerts для нарушения SLO и денежных расхождений.
- [ ] Есть dashboard для matching, ledger, event log, projections и WebSocket.
- [ ] Есть trace от входящей команды до доменного события.
- [ ] Health и readiness checks разделены.

## 8. Проверка перед merge

- [ ] Unit tests проходят.
- [ ] Property-based tests проходят.
- [ ] Contract tests проходят.
- [ ] Integration tests проходят с Testcontainers.
- [ ] E2E-сценарий проходит от команды до read-модели.
- [ ] Failure/replay tests проходят.
- [ ] Security tests проходят.
- [ ] Load test выполнен, latency и consumer lag не ухудшились.
- [ ] `lint`, `typecheck`, `test`, `build` проходят в CI.
- [ ] Документация и ADR обновлены.
- [ ] Нет известных flaky-тестов и необъяснимых исключений из checklist.

## 9. Definition of Done модуля

Модуль готов к следующему этапу только если:

- [ ] его границы и ответственность описаны;
- [ ] публичные команды, события и ошибки задокументированы;
- [ ] позитивные, негативные, граничные, security и failure-сценарии покрыты;
- [ ] инварианты проверяются автоматически;
- [ ] есть локальный `README.md`;
- [ ] есть инструкции запуска и тестирования;
- [ ] есть observability и recovery plan;
- [ ] все необходимые изменения внесены в `docs/` и ADR;
- [ ] модуль можно развивать или выделить без неявных deep dependencies.

## 10. Порядок развития проекта

1. [x] Репозиторий, CI, стандарты и документация.
2. [x] `packages/contracts`: envelope, commands, events и compatibility tests.
3. [x] `health` и infrastructure readiness.
4. [x] `ledger`: accounts, money, postings, reservation и invariants.
5. [ ] `trading/matching-engine`: order book, price-time priority и execution rules.
6. [ ] `trading/sequencer`: partition ordering, idempotency и replay.
7. [x] `trading/settlement`: atomic trade settlement и fees.
8. [x] `gateway`: authentication, validation, rate limits и command API.
9. [x] `projections`: orders, trades и balances read-models.
10. [x] `market-data`: public/private streams, snapshots и gap recovery.
11. [x] `admin`: instrument configuration, limits, circuit breaker и audit.
12. [ ] нагрузочное, failure, security и recovery тестирование всей системы.
13. [x] полнота transport API: REST/OpenAPI для внешних сценариев и AsyncAPI для WebSocket.
14. [x] единое structured logging во всех модулях и transport/application boundaries.
15. [x] observability: metrics, traces, dashboards, alerts и проверяемые SLO.
16. [ ] реалистичное HTTP/WebSocket/processing нагрузочное тестирование.
17. [ ] resilience, chaos и восстановление при деградации зависимостей.
    - [ ] этап 17A: durable runtime и production-like infrastructure для снятия chaos-блокировок.
18. [ ] adversarial, fuzz, race и нестандартные граничные сценарии.
19. [ ] capacity planning и итоговая production-readiness qualification.
20. [ ] maintainability и ступенчатый рефакторинг без изменения public API.
21. [ ] связный production-like trading runtime и продуктовая готовность spot MVP.
22. [x] пользовательская authentication, Redis sessions и безопасное управление identity.

## 11. Пошаговая модульная декомпозиция

Каждый этап выполняется полностью: требования → тесты → реализация → проверки → документация. Переход к следующему этапу запрещён, если gate текущего этапа не пройден.

### Этап 0. Инженерный фундамент

**Цель:** получить воспроизводимый проект и обязательные автоматические проверки.

Модули и файлы:

- [x] pnpm workspace;
- [x] `apps/backend` на NestJS;
- [x] TypeScript strict mode;
- [x] Jest, ESLint, Prettier;
- [x] CI pipeline;
- [x] `docs/`, ADR и module README conventions.

Тесты и проверки:

- [x] CI запускает `lint`, `typecheck`, `test`, `build`;
- [x] есть smoke-тест приложения;
- [x] запрещены секреты и артефакты сборки в Git;
- [x] проверяется отсутствие deep imports между будущими модулями.

Документация:

- [x] обновлены `docs/project-standards.md` и `docs/development-checklist.md`;
- [x] описан локальный запуск;
- [x] описан Definition of Done.

**Gate:** чистый checkout устанавливает зависимости и проходит CI. Для этого этапа добавлены `.github/workflows/ci.yml`, smoke E2E-тест приложения и `pnpm security:check`.

Окружения:

- [x] `.env.development` и `.env.production` содержат только несекретные defaults и committed runtime-настройки;
- [x] development поднимается командой `pnpm docker:development` с hot reload;
- [x] production собирается и запускается командой `pnpm docker:production`;
- [x] обязательные настройки NestJS читаются через `ConfigService.getOrThrow`;
- [x] настройки с безопасным fallback читаются через `ConfigService.get(key, fallback)`;
- [x] production secrets передаются deployment-средой и не хранятся в Git.

### Этап 1. Слой контрактов

**Модуль:** `packages/contracts`.

Объекты:

- [x] message envelope;
- [x] `PlaceOrder`, `CancelOrder`;
- [x] `OrderAccepted`, `OrderRejected`, `OrderCancelled`;
- [x] `TradeExecuted`, `SettlementApplied`;
- [x] общие `Side`, `OrderType`, `TimeInForce`, decimal values.

TDD и проверки:

- [x] valid payload tests;
- [x] invalid payload tests;
- [x] unknown optional fields;
- [x] old message version compatibility;
- [x] duplicate message metadata;
- [x] decimal strings и запрет floating point;
- [x] contract package typecheck/build.

Документация:

- [x] `packages/contracts/README.md`;
- [x] `docs/adr/0002-contract-layer.md`;
- [x] `docs/events/README.md` с каталогом сообщений;
- [x] для каждого сообщения описаны producer, consumers, payload и compatibility policy.

**Gate:** все consumers могут валидировать контракты, а breaking change обнаруживается тестом.

### Этап 2. Health и infrastructure boundary

**Модуль:** `apps/backend/src/modules/health`.

- [x] liveness endpoint;
- [x] readiness endpoint как отдельный контракт;
- [x] correlation ID и базовый structured logging;
- [x] конфигурация окружения с validation.

Тесты:

- [x] liveness не зависит от БД;
- [x] readiness корректно отражает недоступность критичной зависимости;
- [x] некорректная конфигурация блокирует запуск;
- [x] секреты не попадают в response и logs.

Документация:

- [x] обновлён `src/modules/health/README.md`;
- [x] описаны liveness/readiness semantics;
- [x] добавлен runbook диагностики запуска.

**Gate:** приложение безопасно сообщает состояние и не маскирует отказ инфраструктуры.

### Этап 3. Domain primitives и ledger

**Модули:** `ledger`, `shared-kernel`.

Сначала реализовать:

- [x] typed IDs;
- [x] decimal/money value object;
- [x] asset и account;
- [x] available/reserved balance;
- [x] debit/credit posting;
- [x] reservation и release;
- [x] idempotency record.

Инварианты:

- [x] сумма проводок сбалансирована;
- [x] доступный баланс не становится отрицательным;
- [x] reserved не превышает общий баланс;
- [x] повтор операции не создаёт второе списание;
- [x] компенсация не удаляет исходную запись;
- [x] округление детерминировано.

Тесты:

- [x] unit tests value objects и policies;
- [x] property-based tests для сумм и проводок;
- [x] concurrency tests reservation;
- [x] duplicate/retry tests;
- [x] PostgreSQL integration tests;
- [x] migration up/down tests;
- [x] reconciliation tests.

Документация:

- [x] `src/modules/ledger/README.md`;
- [x] `invariants.md` с формулами балансов;
- [x] `flows.md` для reserve/release/posting;
- [x] описание схемы ledger и retention audit records;
- [x] ADR для выбора модели двойной записи.

**Gate:** ledger не создаёт и не теряет стоимость при любых протестированных повторах и отказах.

### Этап 4. Instrument catalog и trading rules

**Модуль:** `market` внутри trading domain или отдельный `instruments`.

- [x] instrument и trading pair;
- [x] base/quote assets;
- [x] tick size, lot size, min/max quantity;
- [x] active/paused status;
- [x] fee policy version;
- [x] price bands и trading limits.

Тесты:

- [x] точность цены и количества;
- [x] invalid tick/lot values;
- [x] instrument lifecycle;
- [x] paused instrument;
- [x] versioned rule effective time;
- [x] invalid configuration cannot enter trading state.

Документация:

- [x] README модуля;
- [x] каталог правил инструмента;
- [x] state diagram lifecycle;
- [x] admin change audit requirements.

**Gate:** любая заявка может быть проверена относительно неизменяемой версии правил инструмента.

### Этап 5. Matching engine

**Модуль:** `trading/matching-engine`.

Состояние:

- [x] bids/asks price levels;
- [x] FIFO queue внутри price level;
- [x] active orders;
- [x] order status и remaining quantity;
- [x] sequence последнего применения.

Правила:

- [x] price-time priority;
- [x] passive order price;
- [x] partial fills;
- [x] limit/market;
- [x] GTC/IOC/FOK;
- [x] cancel;
- [x] self-trade prevention;
- [x] deterministic result независимо от запуска.

Тесты:

- [x] каждый сценарий из правил исполнения;
- [x] empty book и single-level book;
- [x] multi-level match;
- [x] exact/partial/full fill;
- [x] market остаток;
- [x] IOC/FOK;
- [x] cancel before/after match;
- [x] same-price FIFO;
- [x] self-trade prevention;
- [x] property-based random order sequences;
- [x] golden replay fixtures;
- [x] benchmark без сетевых и DB вызовов.

Документация:

- [x] README модуля;
- [x] формальная таблица state transitions;
- [x] Mermaid sequence diagrams;
- [x] описание алгоритма и его сложности;
- [x] каталог rejection codes;
- [x] ADR о порядке price-time.

**Gate:** одинаковая последовательность команд всегда создаёт одинаковые events и итоговый order book.

### Этап 6. Sequencer и trading state machine

**Модули:** `trading/sequencer`, `trading/state-machine`.

- [x] partition ownership по `instrument_id`;
- [x] monotonic sequence;
- [x] command admission;
- [x] deduplication по command/idempotency key;
- [x] deterministic clock policy;
- [x] pause/resume instrument;
- [x] snapshot boundary.

Тесты:

- [x] две команды одного инструмента обрабатываются по порядку;
- [x] разные инструменты могут обрабатываться независимо;
- [x] повтор команды возвращает прежний результат;
- [x] gap sequence обнаруживается;
- [x] crash/restart восстанавливает sequence;
- [x] pause блокирует новые команды по политике;
- [x] replay даёт идентичное состояние;
- [x] partition ownership failure tests.

Документация:

- [x] README и state diagram;
- [x] правила sequence и ordering;
- [x] recovery/replay runbook;
- [x] latency budget критического пути;
- [x] описание backpressure.

**Gate:** нет двойного исполнения, нарушения порядка или потери принятой команды.

### Этап 7. Settlement и event log

**Модули:** `trading/settlement`, event-log adapter.

- [x] reserve до размещения;
- [x] settlement после match;
- [x] maker/taker fees;
- [x] `TradeExecuted` и `SettlementApplied`;
- [x] durable append;
- [x] consumer offset;
- [x] retry и dead-letter policy.

Тесты:

- [x] buy/sell settlement;
- [x] maker/taker fee calculation;
- [x] multi-fill settlement;
- [x] insufficient balance;
- [x] duplicate event;
- [x] event log timeout;
- [x] consumer crash before/after commit;
- [x] ledger/event reconciliation;
- [x] exactly-once business effect through idempotency.

Документация:

- [x] settlement flow;
- [x] posting matrix для каждой сделки;
- [x] event log retention;
- [x] outbox/log-first decision ADR;
- [x] reconciliation и incident runbook.

**Gate:** каждая сделка даёт полный и проверяемый набор проводок и событий.

### Этап 8. Gateway и command API

**Модуль:** `gateway`.

- [x] auth и API keys;
- [x] DTO validation;
- [x] command mapping;
- [x] idempotency headers;
- [x] rate limits;
- [x] pagination и limits;
- [x] безопасные error responses;
- [x] REST endpoint для place/cancel.

Тесты:

- [x] valid/invalid auth;
- [x] role/object authorization;
- [x] malformed payload;
- [x] oversized payload;
- [x] duplicate idempotency key;
- [x] rate limit;
- [x] timeout and retry;
- [x] no sensitive data in errors;
- [x] OpenAPI contract tests;
- [x] API e2e до trading core.

Документация:

- [x] OpenAPI;
- [x] auth and API key guide;
- [x] error code catalog;
- [x] rate limit policy;
- [x] request/response examples;
- [x] security threat model Gateway.

**Gate:** внешний клиент не может обойти валидацию, авторизацию или idempotency.

### Этап 9. Projections и query API

**Модули:** `projections`.

- [x] order history;
- [x] trade history;
- [x] balance projection;
- [x] cursor pagination;
- [x] rebuild from event log;
- [x] projection version.

Тесты:

- [x] projection каждого события;
- [x] duplicate delivery;
- [x] out-of-order/gap detection;
- [x] rebuild equals live projection;
- [x] pagination consistency;
- [x] authorization data isolation;
- [x] schema migration;
- [x] lag metrics.

Документация:

- [x] source event → projection mapping;
- [x] read consistency policy;
- [x] rebuild runbook;
- [x] retention and indexing;
- [x] query API contract.

**Gate:** проекции восстанавливаются из журнала и не показывают данные другого пользователя.

### Этап 10. Market data и WebSocket

**Модуль:** `market-data`.

- [x] public order book snapshot;
- [x] incremental updates;
- [x] trades/ticker;
- [x] private user stream;
- [x] sequence/gap recovery;
- [x] subscription authorization;
- [x] fan-out limits.

Тесты:

- [x] snapshot consistency;
- [x] ordered increments;
- [x] gap detection and resync;
- [x] unauthorized private subscription;
- [x] disconnect/reconnect;
- [x] slow consumer/backpressure;
- [x] burst fan-out;
- [x] no private event leakage.

Документация:

- [x] public/private channel catalog;
- [x] WebSocket protocol;
- [x] snapshot and replay algorithm;
- [x] backpressure policy;
- [x] client reconnection guide.

**Gate:** клиент может восстановить актуальный стакан после разрыва, не получая чужих данных.

### Этап 11. Admin, risk и audit

**Модули:** `admin`, `audit`.

- [x] instrument configuration;
- [x] fee/risk policy changes;
- [x] user/account freeze;
- [x] circuit breaker;
- [x] audit events;
- [x] dual control для критичных операций;
- [x] reconciliation dashboard.

Тесты:

- [x] role matrix;
- [x] forbidden admin actions;
- [x] freeze behavior;
- [x] emergency stop;
- [x] audit completeness;
- [x] tamper detection;
- [x] policy version effective time;
- [x] administrative idempotency.

Документация:

- [x] admin permission matrix;
- [x] audit field catalog;
- [x] emergency stop runbook;
- [x] incident response runbook;
- [x] risk policy and limits;
- [x] retention policy.

**Gate:** критичные действия контролируются, аудируются и обратимы только компенсирующей операцией.

### Этап 12. Системная проверка

- [x] полный E2E: account → balance → order → match → settlement → history;
- [x] повтор всей команды не создаёт повторный эффект;
- [x] restart/replay для trading core;
- [ ] PostgreSQL backup/restore;
- [x] event log retention/archive/restore;
- [x] failure matrix для всех критичных зависимостей;
- [x] security review и threat model update;
- [x] нагрузочный тест Pilot profile;
- [x] WebSocket fan-out test;
- [x] p50/p95/p99 и consumer lag зафиксированы;
- [ ] RTO/RPO проверены практически;
- [ ] все runbooks проверены человеком, не только написаны.

**Финальный gate:** требования, инварианты, тесты, документация и эксплуатационные процедуры согласованы; известные исключения оформлены ADR/issue с ответственным и сроком.

### Этап 13. Полнота transport API и документации

**Модули:** `gateway`, `projections`, `trading/instruments`, `ledger`, `admin`, `market-data`.

Цель этапа — опубликовать уже реализованные application-сценарии через явные
transport boundaries. REST-контроллеры не должны открывать прямой доступ к
внутренним aggregate, проводкам или matching engine: каждый endpoint вызывает
application port, выполняет authentication/authorization и возвращает только
версионированный публичный DTO.

REST API:

- [x] Swagger подключён к NestJS и конфигурация вынесена в `src/config/swagger.ts`;
- [x] Swagger содержит полный API-key lifecycle: identity check, issue, list, rotate и revoke;
- [x] Gateway place/cancel endpoints описаны Swagger metadata и публичными DTO;
- [x] для `instruments` добавлены read endpoints каталога и защищённые admin-команды изменения lifecycle/rules;
- [x] для `accounts/balances` добавлены endpoints создания/получения аккаунта и просмотра доступного/зарезервированного баланса;
- [x] операции изменения баланса доступны только через авторизованный application command, а не через прямое редактирование ledger;
- [x] endpoints `projections` снабжены отдельными request/response DTO, pagination schema, error responses и Swagger decorators;
- [x] для `admin` добавлены endpoints freeze/unfreeze, circuit breaker, policy changes, dual-control approval и reconciliation status;
- [x] для ручной диагностики опубликован read-only audit trail с role checks и bounded pagination;
- [x] все write endpoints требуют idempotency key, object-level authorization и audit metadata;
- [x] DTO не экспортируют внутренние domain entities и не принимают неизвестные поля;
- [x] decimal values во всех HTTP-контрактах передаются строками;
- [x] production-публикация Swagger управляется конфигурацией и по умолчанию отключена.

WebSocket и AsyncAPI:

- [x] реализован настоящий NestJS WebSocket gateway для public и private subscriptions;
- [x] создан версионируемый `docs/asyncapi/market-data.yaml`;
- [x] описаны handshake/authentication, subscribe/unsubscribe, snapshot, increment, trade, ticker и private user events;
- [x] для каждого сообщения заданы schema, sequence, correlation metadata и примеры;
- [x] описаны protocol errors, disconnect reasons, heartbeat и reconnect/resync flow;
- [x] AsyncAPI отражает fan-out limits, backpressure и запрет утечки private events;
- [x] WebSocket schema использует публичные contracts и не раскрывает внутреннее состояние order book или ledger.

Тесты и автоматические проверки:

- [x] OpenAPI smoke-тест проверяет наличие всех обязательных REST operations;
- [x] generated OpenAPI и версионируемые файлы в `docs/openapi/` проверяются на расхождения;
- [x] OpenAPI и AsyncAPI проходят schema validation в CI;
- [x] для каждого endpoint есть positive, validation, authentication, authorization и idempotency contract tests;
- [x] проверены status codes, error codes, pagination limits и отсутствие чувствительных данных;
- [x] API E2E проходит через controller → application port → domain → projection без прямого обхода boundaries;
- [x] WebSocket integration tests проверяют authentication, subscriptions, reconnect, gap recovery и private data isolation;
- [x] contract tests подтверждают обратную совместимость опубликованных REST и WebSocket схем;
- [x] undocumented controller route и документированный, но отсутствующий route блокируют CI.

Документация:

- [x] обновлён каталог REST endpoints с назначением, ролями и ownership rules;
- [x] для всех DTO приведены безопасные request/response examples;
- [x] описаны правила версионирования и deprecation REST API;
- [x] описаны правила версионирования и compatibility AsyncAPI messages;
- [x] добавлен клиентский guide: API key, idempotency, pagination, WebSocket reconnect и gap recovery;
- [x] зафиксировано, какие возможности являются public, private, admin и internal-only;
- [x] README соответствующих модулей ссылаются на OpenAPI/AsyncAPI и application ports;
- [x] все новые публичные интерфейсы, DTO, контроллеры и методы сопровождаются подробным JSDoc на русском языке с принципом работы и примерами.

**Gate:** Swagger содержит все поддерживаемые REST-сценарии, AsyncAPI полностью
описывает WebSocket-протокол, а автоматическая проверка доказывает соответствие
документации фактически запущенному приложению без обхода авторизации,
идемпотентности и domain boundaries.

### Этап 14. Единое structured logging

**Модули:** все application-модули, transport/infrastructure adapters,
background consumers и composition root.

Цель — сделать каждый критичный поток диагностируемым через единый logger, не
превращая логи в источник секретов или дополнительную нагрузочную проблему.

Реализация:

- [x] выбран единый logger adapter и ADR фиксирует production JSON format;
- [x] logger внедряется через DI во все модули, controllers, gateways, consumers и adapters;
- [x] прямые `console.log/error/warn` запрещены ESLint и CI-проверкой;
- [x] определена схема полей: timestamp, level, service, module, event, environment, correlationId, causationId, commandId/eventId, outcome и durationMs;
- [x] HTTP, WebSocket, sequencer, matching, settlement, ledger, event-log, projections, admin, audit и health используют каталог стабильных log events;
- [x] success, rejection, retry, timeout, dependency failure, recovery и shutdown имеют согласованные уровни;
- [x] логирование выполняется на boundaries и изменениях состояния, но не на каждой итерации hot path;
- [x] API keys, authorization headers, cookies, персональные и финансовые payloads проходят централизованную redaction;
- [x] production stack trace доступен только в защищённом internal log event;
- [x] sampling/rate limiting защищают от log storm без потери audit/security событий;
- [x] startup logs различают bind address, public URL, build version и environment;
- [x] audit log остаётся отдельным immutable бизнес-контрактом и не подменяется operational logger.

Тесты и проверки:

- [x] каждый модуль проверяет хотя бы один success и один failure log event;
- [x] contract test блокирует несовместимое изменение обязательных log fields;
- [x] canary secret tests подтверждают отсутствие секретов в message и metadata;
- [x] correlationId/causationId проходят через HTTP → command → event → consumer;
- [x] duplicate/retry не создаёт ложного повторного business-success события;
- [x] benchmark фиксирует CPU, allocation и I/O overhead logger на hot path;
- [x] CI блокирует console output и неизвестные production event names.

Документация:

- [x] создан `docs/observability/logging.md` с каталогом событий и полей;
- [x] описаны уровни, redaction, sampling и retention;
- [x] README каждого модуля перечисляет его основные log events;
- [x] runbook описывает поиск потока по correlationId, commandId и eventId.

**Gate:** принятый или отклонённый критичный запрос прослеживается через все
модули; секреты отсутствуют, а logger не нарушает latency budget.

### Этап 15. Observability, SLI/SLO и alerting

**Сигналы:** logs, metrics и distributed traces. Конфигурация collection,
dashboards и alerting хранится как код и воспроизводится в staging.

Инструментирование:

- [x] определены SLI/SLO для availability, command acceptance, settlement correctness, market-data freshness и projection lag;
- [x] OpenTelemetry context распространяется через HTTP, WebSocket, command envelope, event log и consumers;
- [x] spans покрывают admission, sequencer wait, matching, settlement, ledger commit, event append и projection apply;
- [x] RED metrics покрывают REST/WebSocket, USE metrics — runtime, PostgreSQL, pools, event loop и consumers;
- [x] бизнес-метрики отражают accepted/rejected orders, trades, settlement failures, reconciliation differences, gaps и circuit breaker state;
- [x] histogram buckets соответствуют latency budgets и позволяют вычислять p50/p95/p99;
- [x] labels не содержат userId, orderId, commandId и другие unbounded значения;
- [x] установлены cardinality limits и защита от telemetry overload;
- [x] logs связаны с traces через traceId/spanId, metrics — через exemplars где возможно;
- [x] exporter имеет bounded queue/timeout и не блокирует торговый hot path;
- [x] readiness не зависит от доступности observability backend;
- [x] dashboards и alert rules версионируются и проверяются автоматически.

Тесты и эксплуатационная проверка:

- [x] integration test подтверждает непрерывный trace полного command flow;
- [x] metric contract tests проверяют имена, типы, единицы и разрешённые labels;
- [x] cardinality test с уникальными IDs не создаёт неограниченные series;
- [x] exporter failure не останавливает приложение и отражается internal metric;
- [x] synthetic traffic переводит каждый alert в firing и обратно в resolved;
- [x] dashboards проверены на пустом, нормальном и деградировавшем окружении;
- [x] каждый alert содержит owner, severity, runbook URL и diagnostic context;
- [x] измерены ingestion volume, retention и допустимая потеря non-critical telemetry.

Документация:

- [x] созданы `docs/observability/metrics.md`, `tracing.md`, `slo.md` и `alerts.md`;
- [x] зафиксированы dashboard catalog, ownership и escalation policy;
- [x] описано различие client error, saturation, dependency failure и invariant violation;
- [x] добавлен observability blackout runbook.

**Gate:** дежурный инженер обнаруживает и локализует проблему от клиентского
запроса до зависимости без подключения отладчика.

### Этап 16. Реалистичное нагрузочное тестирование

**Контуры:** REST command/query API, WebSocket streams, sequencer, matching,
settlement, ledger, event log, PostgreSQL и projections.

Профили и данные:

- [x] выбран и зафиксирован нагрузочный runner; для HTTP/WebSocket сценариев используется k6 2.1.0;
- [x] нагрузочные сценарии находятся в версионируемом `tests/load/` и используют общие flow/data builders;
- [x] реализованы smoke, average, stress, spike, soak и breakpoint profiles;
- [x] workload моделирует чтение, place/cancel, partial/multi-fill, private/public subscriptions и reconnect;
- [x] распределение инструментов, аккаунтов, Side/OrderType/TIF и размеров заявок зафиксировано в builders;
- [x] hot instrument и равномерно распределённые instruments конфигурируются отдельно;
- [x] IDs/idempotency keys уникальны, а test data изолируется по runId;
- [ ] тест выполняется с реальными PostgreSQL/event-log adapters, TLS и сетевыми hop;
- [ ] генератор нагрузки запущен на отдельном от SUT compute node и проверено, что он сам не является bottleneck;
- [x] hardware, topology, dataset policy, build SHA и configuration сохраняются с результатом.

Метрики и автоматизация:

- [x] заданы thresholds для throughput, error rate, p50/p95/p99/max и timeout rate;
- [ ] фиксируются consumer/projection lag, event-loop lag, CPU, memory, GC, pool usage, DB locks и network throughput;
- [ ] измеряется accepted-to-settled и accepted-to-visible latency, а не только HTTP response time;
- [x] quick smoke/average profile запускается в CI, полный stress/soak — по расписанию и перед release;
- [ ] regression budget сравнивает результат с измеренным baseline на сопоставимом окружении; автоматическое сравнение со стартовым CI budget уже реализовано;
- [x] failed thresholds завершают pipeline с ненулевым кодом;
- [x] raw results, SVG trend graph и GitHub summary сохраняются как artifacts;
- [ ] после теста выполняются reconciliation и проверка отсутствия потерянных/повторных эффектов.

Документация:

- [x] создан `docs/testing/load-testing.md` с профилями и командами запуска;
- [x] описаны target workload, допущения и различие Pilot baseline от production SLA;
- [x] результаты имеют дату, build SHA, environment и путь/ссылку на artifacts;
- [x] зафиксированы найденные bottlenecks, владельцы и план устранения.

Открытые пункты не являются формальностью: runtime пока использует reference
in-memory command/ledger/event-log adapters. Поэтому accepted-to-settled,
PostgreSQL locks/pool, TLS и проверка полного financial effect не объявляются
выполненными до отдельного staging-прогона на production-like topology.

**Gate:** система выдерживает целевой average и peak profile в рамках SLO, после
нагрузки сходится reconciliation, а деградация имеет измеренную безопасную форму.

### Этап 17. Resilience, chaos и восстановление под нагрузкой

Цель — проверить не только скорость исправной системы, но и сохранение денежных,
ordering и idempotency-инвариантов во время частичных отказов.

Сценарии:

- [x] fault injection разрешён только в изолированном test/staging окружении;
- [ ] проверены latency, timeout, reset и packet loss для PostgreSQL, event log и внешних adapters;
- [ ] проверены pool exhaustion, deadlock, lock contention и временная read-only БД;
- [x] проверены consumer crash до/после commit, duplicate delivery, gap и poison event;
- [ ] process/container kill выполняется во время place, match, settlement и projection apply;
- [ ] rolling restart не нарушает partition ownership и monotonic sequence;
- [ ] retry storm, reconnect storm и thundering herd не обходят rate/backpressure limits;
- [ ] WebSocket slow consumers и массовый reconnect не влияют на matching latency;
- [ ] disk pressure, memory pressure и event-loop stall приводят к контролируемой деградации;
- [x] clock skew и leap/timezone boundaries не меняют deterministic ordering/effectiveAt policy;
- [x] observability backend outage не блокирует business flow;
- [ ] circuit breaker, pause и recovery transitions проверены под продолжающейся нагрузкой.

Проверки результата:

- [ ] ни одна accepted command не потеряна и не применена дважды;
- [x] sequence, ledger balance и immutable audit trail остаются корректными;
- [ ] readiness отражает деградацию и не маскирует отказ критичной зависимости;
- [x] backlog после восстановления уменьшается, а не растёт бесконечно;
- [ ] практически измерены RTO/RPO для каждого класса отказа;
- [x] reconciliation автоматически выполняется после каждого автоматизированного chaos scenario;
- [ ] failure не создаёт утечку stack trace, credential или private event;
- [x] сценарии детерминированы, имеют seed/timeline и сохраняют artifacts.

Документация:

- [x] failure matrix содержит injection method, expected behavior, alert и owner;
- [x] обновлены recovery/replay, dependency outage и reconciliation runbooks;
- [x] описаны stop conditions, blast-radius limits и emergency abort chaos-тестов;
- [ ] результаты game day подписаны участниками и содержат follow-up actions.

**Gate:** при отказе одной критичной зависимости система либо продолжает работу в
заявленном degraded mode, либо безопасно прекращает admission без потери принятой
команды и без нарушения финансовых инвариантов.

Автоматизирован `observability-outage` под продолжающимся k6 workload, а
event-log/sequencer/projection/ledger faults покрыты deterministic component
suite. PostgreSQL network/contention и backend `SIGKILL` остаются blocked, потому
что development composition root использует in-memory adapters. Gate этапа не
закрывается до production-like durable topology и подписанного game day.

### Этап 17A. Durable runtime и infrastructure для закрытия resilience gate

Цель — заменить reference in-memory boundaries на реальные durable adapters и
связать operational controls с admission path. Этот этап является обязательным
prerequisite для оставшихся проверок этапа 17: добавление новых mock fault-тестов
без фактической persistence не считается выполнением.

Архитектура и решения:

- [x] выбран production event-log transport и принят ADR с обоснованием Kafka/Redpanda, PostgreSQL log/outbox или другого решения;
- [x] ADR фиксирует transaction boundary между command journal, ledger, outbox/event log и consumer offset;
- [x] определены source of truth, consistency model и ownership для commands, orders, balances, postings, events, snapshots, offsets, idempotency и audit;
- [x] `TradingCommandPort`, ledger, event-log, projections и audit зависят от application/infrastructure ports, а не от конкретного PostgreSQL/broker client;
- [x] in-memory adapters доступны только для unit/component tests и не могут случайно включиться в staging/production;
- [x] startup блокируется, если production-like environment сконфигурирован с in-memory command, ledger, event-log, idempotency или audit adapter;
- [x] все новые публичные interfaces, adapters, repositories и методы имеют подробный JSDoc на русском языке с принципом работы, инвариантами и примерами.

Durable command и idempotency path:

- [x] command считается accepted только после durable append/commit, а ошибка до commit никогда не возвращает клиенту success;
- [x] command journal хранит commandId, idempotency key digest, payload hash, owner, instrument, sequence, status, correlation/causation metadata и timestamps;
- [x] idempotency record хранится в PostgreSQL/shared durable store и атомарно связывает ключ, identity, payload hash и прежний public result;
- [x] concurrent duplicate requests сериализуются unique constraint/transaction policy и не создают второй business effect;
- [x] повтор после process restart возвращает прежний public result либо безопасный pending/recovery status;
- [x] accepted, processing, applied, rejected и recovery transitions являются монотонными и аудируемыми;
- [x] retry policy имеет bounded attempts/backoff/jitter и не допускает retry storm или бесконечный pending state.

Ledger, settlement и event log:

- [x] PostgreSQL ledger repository сохраняет accounts, balances, reservations, postings, operations и compensation links транзакционно;
- [x] debit/credit posting set, balance mutation и idempotency record фиксируются одной atomic transaction;
- [x] constraints/locking policy запрещают отрицательный available, `reserved > total` и несбалансированный posting set;
- [x] settlement создаёт `TradeExecuted`, полный posting set и `SettlementApplied` без окна потери между DB и event log;
- [x] реализован transactional outbox либо эквивалентный log-first protocol с crash-safe publisher recovery;
- [x] event append дедуплицируется по eventId, consumer effect — по eventId/operationId, а offset commit следует только после business commit;
- [x] poison events имеют retry metadata, quarantine/DLQ, operator action и безопасный replay без редактирования исходного события;
- [ ] audit records хранятся append-only с tamper-evident chain, retention и отдельными правами записи;
- [x] migrations имеют reversible up/down там, где это безопасно, forward-only policy для audit/ledger данных и проверку compatibility rolling deployment.

Append-only trigger, hash chain и retention для audit реализованы и проверены.
Пункт остаётся открытым до выделения отдельной database role для записи audit в
production topology: использование owner/superuser приложения не считается
достаточным разделением прав.

Sequencer, ownership и recovery:

- [x] instrument partition ownership хранится как lease с fencing token/epoch, поэтому старый owner не может писать после передачи partition;
- [x] sequence резервируется и фиксируется монотонно вместе с durable command state;
- [x] snapshot содержит version, instrumentId, last sequence, checksum и boundary event offset;
- [x] snapshot создаётся без пропуска in-flight accepted commands и восстанавливается только после проверки checksum/version;
- [ ] restart выполняет snapshot restore и ordered replay до durable high watermark перед открытием admission;
- [ ] rolling restart передаёт ownership без двух активных writers и без starvation других instruments;
- [x] graceful shutdown прекращает admission, завершает либо сохраняет in-flight work, фиксирует offsets и освобождает lease;
- [x] projection хранит processed event IDs и offset в одной transaction с read-model mutation, а rebuild работает параллельно через versioned shadow tables/swap.

Storage-level recovery plan, checksum, contiguous replay и high-watermark gate
реализованы и проверены на PostgreSQL. Полный restart/rolling пункт остаётся
открытым до подключения restore/replay к фактическому matching-engine state и
process-kill теста минимум с двумя backend replicas.

Admission, risk controls и readiness:

- [x] `AdminService` и Gateway используют общий durable admission-control port для freeze, instrument pause и circuit breaker;
- [x] `GatewayController` проверяет admission policy до durable acceptance place/cancel command и возвращает стабильный безопасный rejection code;
- [x] circuit breaker/pause transition имеет dual control, idempotency, effectiveAt, audit metadata и компенсационный resume;
- [x] состояние control plane восстанавливается до открытия HTTP/WebSocket admission после restart;
- [x] PostgreSQL, event log, lease/ownership store и другие критичные dependencies зарегистрированы в `HEALTH_DEPENDENCIES`;
- [x] readiness возвращает `503` при невозможности безопасно принять команду, но liveness не зависит от БД, broker и observability;
- [x] observability exporter остаётся некритичной dependency с bounded queue/timeout и не влияет на readiness;
- [x] dependency probes имеют bounded timeout, не содержат destructive queries и не создают дополнительную перегрузку при outage.

Production-like test topology:

- [x] `docker-compose`/staging поднимает backend, PostgreSQL, выбранный event log, migrations, observability и fault proxy одной командой;
- [x] PostgreSQL и event-log traffic проходит через Toxiproxy либо эквивалентный управляемый fault boundary;
- [x] fault proxy недоступен из production profile и требует того же explicit safety interlock, что chaos runner;
- [x] topology поддерживает latency, bandwidth limit, timeout, reset, packet loss и temporary disconnect для каждой dependency отдельно;
- [ ] PostgreSQL profile позволяет воспроизвести pool exhaustion, deadlock, lock contention, read-only mode, failover и disk pressure;
- [x] backend запускается минимум в двух replicas для проверки rolling restart, lease/fencing и thundering herd;
- [x] load generator находится вне SUT containers, использует TLS/network hops и сохраняет build SHA, topology и resource limits;
- [ ] CPU, memory, disk, file-descriptor и event-loop pressure имеют bounded injection method и emergency abort.

Staging использует PostgreSQL transactional outbox как выбранный event log,
поэтому database и event-log fault boundary является одной атомарной
dependency `postgres-outbox`. Toxiproxy API слушает только loopback, а
fault-agent запускается исключительно профилем `fault-injection` после двойного
safety interlock. Pool exhaustion, lock contention, deadlock и read-only recovery
автоматизированы. Physical streaming standby/promote дополнительно подтверждает
failover с RTO 1803 мс и RPO=0; составной пункт PostgreSQL profile остаётся
открытым только до pressure на отдельном quota-limited data volume.

Обязательные тесты:

- [x] integration tests PostgreSQL repositories выполняются против настоящего PostgreSQL, включая concurrent duplicate и transaction rollback;
- [x] migration tests проверяют clean up, upgrade с предыдущей schema, rollback policy и сохранность ledger/audit данных;
- [ ] crash-point tests покрывают до/после command commit, outbox append, publish, ledger commit, offset commit и snapshot boundary;
- [x] `SIGKILL` после accepted response подтверждает RPO=0 и прежний idempotent result после restart;
- [ ] process kill во время reserve, match, settlement и projection apply не оставляет частичного финансового эффекта;
- [x] network fault tests покрывают PostgreSQL/event-log latency, timeout, reset, packet loss и восстановление connection pool;
- [x] contention tests покрывают pool exhaustion, deadlock retry, lock timeout и временную read-only БД;
- [ ] rolling restart tests подтверждают один active owner, fencing старого owner и непрерывный monotonic sequence;
- [x] circuit breaker, freeze, pause/resume и recovery transitions проверяются под продолжающейся command-нагрузкой;
- [ ] retry/reconnect storm, thundering herd и slow WebSocket consumers не обходят rate limits/backpressure и не ухудшают matching p99 сверх budget;
- [ ] disk/memory/event-loop pressure приводит к documented degraded mode либо закрытию admission без OOM/corruption;
- [ ] readiness/liveness contract tests проверяют каждую critical/non-critical dependency отдельно;
- [x] после каждого scenario автоматически сравниваются accepted commands, events, ledger postings, offsets, sequence, projections и audit chain;
- [ ] canary tests проверяют отсутствие credential, stack trace, financial payload и private WebSocket event в response/logs/artifacts;
- [x] каждый scenario имеет deterministic seed/timeline, stop conditions, cleanup verification и машиночитаемые RTO/RPO.

Фактические локальные прогоны `network-faults`, `durable-process-kill`,
`postgres-contention`, `rolling-ownership` и `controls-under-load` завершились с
успешными reconciliation и cleanup. Rolling test подтверждает transfer и
непрерывную sequence, но общий пункт оставлен открытым до явной попытки записи со
старым fencing token и проверки starvation. Credential canary уже блокирует
pipeline и выявил/закрыл утечку `X-Api-Key` в Caddy error log; полный составной
пункт ждёт stack-trace, financial-payload и private-WebSocket canaries.

Дополнительно `postgres-failover` прошёл с physical standby promotion,
RTO 1803 мс и RPO=0. `resource-pressure` прошёл для CPU, memory, `nofile=96` и
event-loop freezer с обязательным recovery; disk pressure остаётся открытым до
безопасного quota-limited PostgreSQL volume.

Dual-control request и approval в автоматическом controls-сценарии выполняются в
однорепличном окне при продолжающемся command workload. Durable applied state
виден обеим репликам, однако pending approval всё ещё хранится в памяти
`AdminService`; cross-replica approval/restart recovery остаётся обязательным
незакрытым infrastructure requirement.

CI, staging и эксплуатационная приёмка:

- [x] PR pipeline запускает repository/migration/crash-point component tests без privileged fault injection;
- [ ] scheduled staging pipeline запускает network, resource, process-kill, rolling restart и storm scenarios;
- [ ] CI всегда сохраняет timeline, dependency/container logs, k6 result, metrics snapshot, reconciliation и cleanup status;
- [x] failed cleanup, invariant violation, RPO больше нуля или secret/private-data leak всегда завершают pipeline ошибкой;
- [ ] alerts реально переходят в firing/resolved для каждого failure class и содержат owner/runbook URL;
- [ ] измерены RTO/RPO отдельно для PostgreSQL outage, event-log outage, backend kill, owner failover, projection rebuild и observability blackout;
- [ ] проведён game day на release-candidate build, а operator и независимый reviewer подписали результаты;
- [ ] follow-up actions содержат severity, owner, deadline и ссылку на issue; критичные findings блокируют release.

Документация:

- [x] созданы ADR durable command/event/transaction model и ADR partition lease/fencing;
- [ ] описаны database/event-log schemas, indexes, isolation levels, lock ordering, retention и capacity assumptions;
- [ ] обновлены failure matrix, SLO/alerts, deployment, backup/restore, replay, dependency outage и reconciliation runbooks;
- [ ] создан game-day template с environment/build SHA, seed, timeline, RTO/RPO, alerts, findings, signatures и go/no-go решением;
- [ ] module README перечисляют production adapters, health dependencies, recovery order и запрещённые обходы boundaries.

**Gate:** staging/production composition root не содержит in-memory state на
критическом write path; accepted command переживает `SIGKILL` с RPO=0 и
идемпотентным результатом, PostgreSQL/event-log failures корректно управляют
readiness/admission, rolling ownership не допускает двух writers, а полный набор
оставшихся сценариев этапа 17 выполняется на production-like topology. После
этого этап 17 повторяется целиком и закрывается подписанным game-day report.

### Этап 18. Adversarial и нестандартные граничные сценарии

Входные данные и протоколы:

- [x] property-based/fuzz tests генерируют команды, события и последовательности операций с воспроизводимым seed;
- [x] проверены пустые, oversized, deeply nested, truncated и malformed JSON payloads;
- [x] проверены Unicode normalization, control characters, duplicate JSON keys и необычные identifiers;
- [x] decimal tests покрывают ноль, максимальную точность, очень большие значения, ведущие нули, exponent, NaN/Infinity и rounding boundaries;
- [x] timestamps покрывают прошлое/будущее, одинаковый effectiveAt, clock rollback и timezone/DST boundaries;
- [x] pagination проверена при параллельном добавлении данных, stale/tampered cursor и изменении projection version;
- [x] REST/WebSocket protocol fuzzing не приводит к uncaught exception или process crash;
- [x] неизвестная версия/тип сообщения отклоняется либо обрабатывается по compatibility policy.

Покрыто автоматическим набором `pnpm adversarial:check`: contract property tests
используют seed `18001`, REST fuzzing — `18002`, WebSocket fuzzing — `18003`.
Публичные identifiers на gateway/contract boundary ограничены bounded ASCII
allow-list, чтобы Unicode-confusable и control characters не попадали в
idempotency, audit и ordering state.

Гонки и злоупотребления:

- [x] проверены concurrent duplicate place, cancel-vs-match, freeze-vs-place и pause-vs-admission;
- [x] settlement-vs-retry и projection rebuild-vs-live delivery дают exactly-once business effect;
- [x] один idempotency key с разными payloads/identities всегда конфликтует;
- [ ] hot-key, hot-instrument и skewed partition не приводят к starvation остальных partitions;
- [ ] rate-limit bypass через reconnect, headers, API keys и distributed clients закрыт;
- [x] authorization isolation проверена массовой матрицей users/accounts/orders/subscriptions;
- [x] WebSocket subscription churn, invalid ack ordering и sequence wrap/large values обработаны безопасно;
- [ ] zip/decompression bomb, slow request и connection exhaustion ограничены transport configuration;
- [x] любой unexpected input даёт документированный 4xx/protocol error, но не 500 и не утечку данных.

`pnpm adversarial:check` дополнительно запускает race/abuse e2e: concurrent
duplicate place сериализуется in-flight idempotency index, конфликт payload
возвращает `409`, freeze/pause блокируют admission до business effect, cancel
retry не вызывает второй cancel. Settlement/projection/sequencer specs входят в
тот же набор. Distributed rate-limit bypass, hot-partition starvation и
transport-level slow/connection exhaustion остаются открытыми до отдельного
multi-client runner и reverse-proxy timeout limits.

Автоматизация и документация:

- [x] найденный fuzz/property failure сохраняется как минимальный regression fixture;
- [ ] nightly pipeline имеет ограничение времени, corpus retention и triage owner;
- [ ] security tools покрывают dependencies, container image, secrets, SAST и API threat model;
- [x] создан `docs/testing/adversarial-cases.md` с каталогом классов входов и ожидаемыми outcomes;
- [x] flaky race test не отключается без issue, owner и срока исправления.

**Gate:** некорректные, враждебные и конкурентные входы не нарушают isolation,
идемпотентность, ordering, денежные инварианты и доступность процесса.

### Этап 19. Capacity planning и production-readiness qualification

Capacity и длительная устойчивость:

- [ ] найден maximum sustainable throughput и saturation point каждого критического компонента;
- [x] production target использует согласованный headroom для traffic burst и отказа одного instance/node;
- [ ] измерено влияние числа instruments, active orders, accounts, event history и projection size;
- [ ] отдельный soak test выявляет memory/handle/connection leaks и рост GC pause;
- [ ] проверены лимиты PostgreSQL connections, storage growth, indexes, WAL/event retention и archive throughput;
- [x] autoscaling policy основана на causal metrics: queue/lag/CPU, а не только среднем CPU;
- [ ] scale-out/scale-in не нарушает partition ownership, ordering и WebSocket sessions;
- [ ] graceful shutdown завершает или безопасно передаёт accepted work;
- [ ] deploy/rollback совместимы с активными clients, предыдущей schema и in-flight events;
- [ ] стоимость инфраструктуры и telemetry оценена для average/peak/retention profiles.

`docs/operations/capacity-plan.md` фиксирует production target, headroom, N+1
требование, causal autoscaling metrics, owners и cost model. Фактические
maximum sustainable throughput, saturation point, scale dimensions, soak leaks,
PostgreSQL storage/WAL/archive и telemetry cost остаются открытыми до
release-candidate прогонов с artifacts.

Release qualification:

- [ ] black-box API flow pipeline проходит против release candidate environment;
- [ ] smoke, average, spike, soak, chaos, recovery и adversarial suites имеют зелёные отчёты;
- [ ] SLO/error budget и performance regression budgets соблюдены;
- [ ] backup/restore, archive/restore и region/node recovery проверены практически;
- [ ] dashboards, alerts и runbook links проверены дежурным инженером;
- [ ] открытые исключения имеют severity, owner, deadline и формальное risk acceptance;
- [x] release report содержит build SHA, конфигурацию, результаты и решение go/no-go;
- [ ] rollback criteria и emergency stop rehearsed до production deployment.

Документация:

- [x] создан `docs/operations/capacity-plan.md`;
- [x] создан versioned production-readiness report template;
- [x] определены владельцы SLO, capacity, on-call и release decision;
- [x] baseline и trend history доступны для сравнения следующих releases.

Production-readiness framework проверяется командой `pnpm readiness:check` и
запускается в CI. Release qualification пункты, требующие живого
release-candidate окружения, подписанного отчёта или rehearsal человеком,
остаются открытыми до фактической приёмки.

Фактический automated quick qualification прогнан командой `pnpm ready:quick`:
run `d1aac30e0c31`, build `5086d3ed98451e9f3ce8361bd558c95ab4336fec`,
artifact `artifacts/readiness/quick-d1aac30e0c31`. Пройдены
`security:check`, `maintainability:report`, `lint`, `typecheck`,
`contracts:check`, `observability:check`, `adversarial:check`,
`readiness:check` и `build`. Этот прогон подтверждает framework/quality gate,
но не закрывает capacity/release qualification пункты, где нужны
release-candidate topology, load/soak/chaos artifacts и human sign-off.

**Финальный gate:** release допускается к production только при доказанной
устойчивости под целевой и аварийной нагрузкой, практически проверенном recovery и
отсутствии необъяснимых нарушений SLO или доменных инвариантов.

### Этап 20. Maintainability и ступенчатый рефакторинг

Цель — снизить когнитивную нагрузку поддержки без изменения бизнес-поведения и
публичных контрактов.

- [x] создан `docs/operations/business-readiness.md` с командами проверки готовности биржи;
- [x] создан `docs/refactoring-plan.md` со ступенями дробления и Definition of Done;
- [x] добавлен `pnpm maintainability:report` для поиска крупных файлов и baseline перед рефакторингом;
- [x] добавлены one-button readiness scripts `ready:quick`, `ready:business`, `ready:rc`, `ready:full`;
- [x] `pnpm maintainability:report` включён в one-button readiness и CI в blocking baseline mode;
- [ ] test builders вынесены из крупных e2e/spec файлов;
- [x] Gateway/WebSocket transport orchestration разделён на mapper/registry/error policy;
- [x] Admin service разделён на dual-control, policy registry и reconciliation services;
- [x] settlement/projections/ledger adapters разделены на policy, mapper и repository слои;
- [ ] architecture guard переведён из report-only в blocking CI после закрытия P0/P1 файлов.

Первый срез test builders выполнен для `api-flow.e2e-spec.ts` и
`transport-api.e2e-spec.ts`: API key registry, account/order DTO и instrument
rules вынесены в `apps/backend/test/builders/api-builders.ts`. Второй срез
выполнен для `market-data.websocket.e2e-spec.ts`: Socket.IO client helpers,
envelope ожидания, API key registry и common subscribe/heartbeat payloads
вынесены в `apps/backend/test/builders/market-data-builders.ts`. Общий пункт
дополнен durable runtime builders для PostgreSQL ledger/runtime spec:
`apps/backend/test/builders/durable-runtime-builders.ts` содержит place-order и
settlement fixtures. Общий пункт остаётся открытым до выноса builders из system
и resilience specs.

Gateway переведён на семантическую структуру `controllers/`, `dto/`,
`validation/`, `auth/`, `ports/`, `types/`, `application/` и `infrastructure/`.
REST Gateway transport стал читаемее через отдельные auth/validation/application
границы и публичный barrel `../gateway`. WebSocket `MarketDataGateway`
дополнительно разделён на connection policy, subscription registry, envelope
factory, telemetry observer и `MarketDataErrorPolicy` для безопасного protocol
error mapping.

Admin и audit переведены на семантические папки, а `AdminService` оставлен
публичным фасадом над `AdminDualControlService`, `AdminPolicyRegistry` и
`AdminReconciliationService`. Role matrix, dual-control pending lifecycle,
fee/risk policy lookup и reconciliation dashboard теперь обсуждаются отдельно
от transport фасада.

Ledger переведён на семантическую структуру `controllers/`, `dto/`,
`application/`, `ports/`, `domain/` и `infrastructure/`. Внешний API модуля
сохранён через публичный barrel `../ledger`, а README теперь описывает движение
`controller → application service → LedgerPort → domain/infrastructure`.
`PostgresLedgerAdapter` дополнительно разделён на repositories для assets,
accounts, balances, operations, postings и reservations.

Projections переведён на семантическую структуру `controllers/`, `dto/`,
`types/`, `ports/`, `application/` и `infrastructure/`. Типы read-model вынесены
из in-memory store в `types/`, а внешние импорты переведены на публичный barrel
`../projections`. `PostgresProjectionStore` дополнительно разделён на
repositories для projection versions, processed events, orders, trades и
balances. Составной пункт по projections остаётся открытым до выноса event
appliers, pagination policy и rebuild coordinator в самостоятельные классы.

Settlement получил отдельные `SettlementPostingPolicy` и
`SettlementEventMapper`: формула posting matrix, JSON-safe decimal
serialization и `SettlementApplied` mapping вынесены из orchestration сервиса.

Health переведён на семантическую структуру `controllers/`, `application/`,
`ports/` и `types/`. README описывает, что liveness не вызывает dependency
probes, а readiness идёт через bounded `HEALTH_DEPENDENCIES` port и возвращает
только безопасный агрегированный статус.

Market-data gateway разгружен через semantic helpers: connection policy,
subscription registry, envelope factory, typed socket events и telemetry
observer, а `MarketDataErrorPolicy` централизует safe protocol errors без
утечки exception payload или stack trace.

Observability metrics разгружен на `metrics.catalog.ts`,
`metrics-label.policy.ts` и `MetricsService`. Публичные exports сохранены, а
catalog/policy теперь можно проверять и обсуждать отдельно от recording logic.

Market-data переведён на семантическую структуру `domain/`, `dto/`,
`gateways/`, `policies/`, `registries/`, `transport/`, `validation/`;
`MarketDataHub` отделён от Socket.IO gateway, а public barrel скрывает
внутренние transport helpers. Observability переведён на `logging/`, `metrics/`,
`tracing/`, `alerts/` с сохранением внешнего импорта через
`../observability`.

CI уже блокирует ухудшение текущего baseline через
`MAINTAINABILITY_ENFORCE=true pnpm maintainability:report`; строгий architecture
guard 300/450/500 строк остаётся открытым до закрытия P0/P1 файлов.

**Gate:** каждый refactor PR уменьшает или сохраняет сложность выбранного модуля,
проходит business-readiness проверки и не меняет public API без отдельного
contract test.

### Этап 21. Связный trading runtime и продуктовая готовность spot MVP

**Цель:** превратить набор реализованных доменных и infrastructure-подсистем в
единый работающий торговый контур. Публично принятая команда должна приводить к
резервированию, детерминированному matching, settlement, обновлению проекций и
публикации market data без ручных вызовов сервисов, test-only adapter или
in-memory shortcut.

Текущая граница проекта:

- [x] реализованы отдельные модули gateway, instruments, sequencer, matching engine, ledger, settlement, event log, projections, market data, admin, audit и observability;
- [x] production-like command adapter долговечно сохраняет place/cancel command, sequence и outbox event;
- [x] фактический application runtime автоматически выполняет полный путь `command → reserve → match → settle → project → publish` в `TradingRuntimeProcessor`;
- [x] две встречные заявки, отправленные только через публичный REST API, создают реальную сделку, проводки, историю и WebSocket events;
- [x] статус `APPLIED` используется только после фактического применения бизнес-операции, а не сразу после записи команды в journal;
- [x] ни development, ни staging UI/API flow не сообщают об успешной сделке на основании одного `OrderAccepted`.

#### P0. Trading application pipeline

- [x] создан `TradingCommandProcessor` или эквивалентный application orchestrator, читающий durable accepted commands в порядке instrument sequence;
- [x] processor получает command через application/infrastructure port и не зависит напрямую от HTTP controller;
- [x] place command проходит immutable version instrument rules, price/quantity, tick/lot, lifecycle, price band и risk-limit validation;
- [x] до допуска BUY резервируется quote asset и fee budget, до допуска SELL резервируется base asset;
- [x] недостаточный баланс, paused instrument, invalid rules и risk rejection завершаются стабильным `OrderRejected` без частичного эффекта;
- [x] validated command передаётся единственному active owner инструмента и применяется к восстановленному matching state;
- [x] matching events сохраняются durable до публикации внешнего результата;
- [x] `TradeExecuted` запускает idempotent settlement и создаёт полный сбалансированный posting set;
- [x] cancel, IOC remainder, rejected и terminal order освобождают неиспользованный резерв ровно один раз;
- [x] `SettlementApplied` появляется только после atomic ledger commit;
- [x] order/trade/balance projections обновляются runtime consumer-ом application event flow, а не прямым вызовом из controller;
- [x] public/private market-data messages создаются из committed domain events и не раскрывают ledger или внутреннее состояние matching engine;
- [x] correlationId, causationId, commandId, eventId и instrument sequence проходят через весь поток;
- [x] один production composition root не допускает альтернативного обхода sequencer, reservation, settlement или outbox.

`apps/backend/src/modules/trading/runtime/trading-runtime.processor.ts`
реализует связный in-process application processor и покрыт тестом
`trading-runtime.processor.spec.ts`: две встречные команды через
`TradingCommandPort` создают reserve, deterministic match, `TradeExecuted`,
`SettlementApplied`, projections и market-data snapshot. Processor подключён к
Nest composition root через `TradingRuntimeModule`: `GatewayModule` больше не
зависит от `MarketDataModule` напрямую, потому что security/idempotency/rate
providers вынесены в `GatewayCommonModule`. В development profile
`TRADING_COMMAND_PORT` указывает на runtime processor, а PostgreSQL command
adapter вызывает тот же processor после durable acceptance и сохраняет
`APPLIED` только после фактического результата. Durable production-hardening
остаётся для отдельного шага: нужен самостоятельный command-journal consumer с
offset/high-watermark вместо synchronous adapter call.
Production-like staging proof `pnpm business:e2e:staging` подтверждает, что
публичный REST path больше не ограничивается durable acceptance: crossing
buyer/seller заявки доходят до reserve, deterministic match, balanced settlement,
projections, WebSocket market data и idempotent result после SIGKILL/restart.

#### P0. Жизненный цикл команды и заявки

- [x] command lifecycle различает `RECEIVED`, `ACCEPTED`, `PROCESSING`, `APPLIED`, `REJECTED` и `RECOVERY_REQUIRED`;
- [x] order lifecycle различает `PENDING`, `OPEN`, `PARTIALLY_FILLED`, `FILLED`, `CANCEL_PENDING`, `CANCELLED` и `REJECTED`;
- [x] публичный result явно разделяет durable acceptance и фактический результат исполнения;
- [x] повтор команды возвращает прежний terminal result либо безопасный pending/recovery status;
- [x] несовместимое повторное использование commandId или idempotency key всегда даёт conflict;
- [x] cancel не может воскресить, повторно закрыть или изменить уже terminal order;
- [x] переходы статусов монотонны, версионированы и покрыты формальной transition table;
- [x] rejection codes едины между REST, WebSocket, OpenAPI, AsyncAPI, projections и audit.

Source of truth добавлен в
`apps/backend/src/modules/trading/lifecycle/trading-lifecycle.ts`, contract tests
проверяют command/order transition tables и terminal cancel protection.
Публичный Gateway result теперь содержит `durableStatus`, `executionStatus`,
`orderStatus` и optional `rejectionCode`; поле `status` оставлено как deprecated
compatibility alias для старых клиентов. Формальная таблица описана в
`docs/trading-lifecycle.md`. PostgreSQL migration расширена до `RECEIVED` и
`RECOVERY_REQUIRED`, а trigger запрещает обратные terminal переходы.

#### P0. Durable workers и восстановление

- [x] composition root запускает управляемые command, outbox, settlement, projection и market-data consumers;
- [x] каждый worker имеет bounded batch/concurrency, timeout, retry/backoff/jitter, DLQ/quarantine и lag metric;
- [x] offset фиксируется только после соответствующего business commit;
- [x] graceful shutdown прекращает admission, завершает либо сохраняет in-flight work и фиксирует offsets;
- [x] restart восстанавливает lease, snapshot и ordered replay до high watermark до открытия admission;
- [x] worker crash между любыми двумя commit points не теряет accepted command и не создаёт повторную сделку или проводку;
- [x] readiness учитывает невозможность безопасной command processing, но observability outage остаётся non-critical;
- [x] backlog после recovery измеримо уменьшается и имеет alert/runbook;
- [x] operator может безопасно повторить quarantined event без изменения исходной записи.

Добавлен модуль `apps/backend/src/modules/trading/workers`: `DurableWorkerManager`
управляет command/outbox/settlement/projection/market-data workers через единый
bounded lifecycle, фиксирует `exchange_consumer_lag_events`, drain-ит in-flight
batch на shutdown и участвует в readiness как critical dependency. Worker policy
валидируется через env `WORKER_*`, а runbook описан в
`apps/backend/src/modules/trading/workers/README.md`. Текущий managed слой
закрывает lifecycle/retry/readiness/replay envelope; следующий production-hardening
шаг — выделить named PostgreSQL/Kafka consumer adapters с независимыми offsets
для каждого worker вместо общего `EventLogPort`.

#### P0. Доказательный black-box business E2E

Тест выполняется против production-like staging исключительно через публичные
REST/WebSocket contracts и прямые read-only проверки reconciliation. Прямое
создание `MatchingEngine`, `SettlementService`, projection fixture или подмена
`TradingCommandPort` в этом сценарии запрещены.

- [x] создаются независимые buyer и seller identities/accounts;
- [x] buyer получает USD, seller получает BTC через авторизованный funding command;
- [x] seller размещает limit sell, buyer — crossing limit buy;
- [x] обе стороны получают корректные accepted/open/fill/terminal transitions;
- [x] проверены exact, partial и multi-fill варианты;
- [x] `TradeExecuted` содержит passive maker price и правильные maker/taker стороны;
- [x] ledger содержит сбалансированный posting set, комиссии и корректные available/reserved balances;
- [x] order и trade history обеих сторон согласованы с ledger и event log;
- [x] public order book, trades/ticker и private user streams отражают те же sequence/events;
- [x] private events buyer никогда не получает seller и наоборот;
- [x] повтор place/cancel/trade delivery не создаёт второй business effect;
- [x] после `SIGKILL` и restart прежний idempotent result доступен, processing продолжается и RPO равен нулю;
- [x] финальная reconciliation сравнивает commands, orders, trades, events, postings, offsets, projections и audit chain;
- [x] pipeline сохраняет timeline, build SHA, topology, logs, traces, metrics, WebSocket transcript и reconciliation report.

Добавлен доказательный black-box runner `pnpm business:e2e`,
`pnpm business:e2e:staging` и `pnpm business:e2e:check`
(`scripts/run-business-e2e*.mjs`). Он не импортирует
`MatchingEngine`, `SettlementService`, projection fixtures или
`TradingCommandPort`; setup и проверки выполняются через REST/WebSocket и admin
reconciliation. Pipeline включён в `ready:business`, `ready:rc` и `ready:full`,
сохраняет `report.json`, `timeline.json`, `websocket-transcript.json` и
`summary.md` в `artifacts/business-e2e*/`.

Фактический production-like staging прогон `pnpm business:e2e:staging` с build
`dca13c53fc5b0380c75d60f76d138dfad75e2c0b` прошёл успешно:
`status=passed`, `failures=0`, `checks=44`, `topology=staging-compose`,
`runId=7a5aac50520a`. Сценарий поднял PostgreSQL, migrations, ingress, две
backend replicas и observability, затем через публичные REST/WebSocket contracts
проверил readiness, API keys, создание/активацию `BTC-USD`, buyer/seller
accounts, funding, exact/partial/multi-fill заявки, `TradeExecuted`, passive
maker price, maker/taker sides, order/trade/balance projections, market-data
events, private stream isolation, duplicate retry, SIGKILL/restart и финальную
reconciliation. Публичный place result больше не остаётся `PENDING`: adapter
сохраняет `APPLIED` только после фактического runtime apply.

Development profile остаётся быстрым диагностическим контуром, но не считается
durable recovery proof. Для закрытия MVP gate и one-button readiness используется
`pnpm business:e2e:staging`.

В ходе прогона устранены подготовительные дефекты: `Ledger.registerAsset()`
выровнен с PostgreSQL adapter и идемпотентно подтверждает идентичную asset
definition; runner создаёт buyer/seller accounts последовательно и использует
account identifiers, совместимые с текущей object-level authorization policy
Gateway; development wrapper автоматически выполняет bounded SIGKILL/restart
backend и сохраняет backend logs как artifact.

#### P1. Durable product state

- [ ] users/identities и ownership являются durable source of truth;
- [ ] API keys, scopes, expiry, status, rotation и revoke хранятся в PostgreSQL или отдельном credential store и переживают restart;
- [ ] API key secret показывается только при выпуске, в storage хранится lookup digest, а metadata полностью аудируется;
- [ ] instrument catalog и все версии trading rules хранятся durable и восстанавливаются до admission;
- [ ] fee/risk policy versions и `effectiveAt` хранятся durable и прикрепляются к принятой заявке;
- [ ] pending dual-control approvals доступны другой replica и переживают restart;
- [ ] account freeze, instrument pause и circuit breaker имеют единое durable control-plane состояние;
- [ ] runtime safety запрещает memory implementations этих boundaries в staging/production.

#### P1. Обязательные функции spot MVP

- [ ] API возвращает open orders, order details, status transitions, fills и fee breakdown;
- [ ] реализован `cancel all` с account/instrument scope, authorization, idempotency и bounded batch;
- [ ] публичный REST API отдаёт согласованный snapshot стакана с sequence;
- [ ] WebSocket публикует реальные order-book increments, trades и ticker из committed matching events;
- [ ] private WebSocket stream публикует order status, fills и balance changes владельца;
- [ ] клиент может восстановиться после disconnect через snapshot + increments и обнаружение gap;
- [ ] rejection responses объясняют insufficient balance, invalid tick/lot, paused market, price band, risk limit и rate limit безопасными кодами;
- [ ] API предоставляет текущие instrument rules, fee policy version и применённые к заявке версии правил;
- [ ] история поддерживает cursor pagination без duplicate/missing items при параллельных обновлениях;
- [ ] sandbox/test identities и API keys отделены от production credentials и данных.

#### P1. Пользовательский trading terminal

Текущая React test console сохраняется как инженерный diagnostics-инструмент.
Пользовательский terminal строится отдельными feature boundaries поверх тех же
публичных REST/WebSocket contracts.

- [ ] добавлены market selector и отображение статуса инструмента;
- [ ] добавлены order book, recent trades и ticker;
- [ ] добавлена безопасная форма BUY/SELL с preview количества, стоимости и комиссии;
- [ ] добавлены available/reserved balances;
- [ ] добавлены open orders, cancel/cancel-all, order history и trade history;
- [ ] UI различает accepted, pending, partial, filled, cancelled и rejected состояния;
- [ ] отображаются WebSocket connection, lag, last sequence, gap и resync status;
- [ ] ошибки показывают публичный error code/correlationId без stack trace и чувствительных payloads;
- [ ] API keys не встраиваются в frontend bundle и не записываются в логи/telemetry;
- [ ] frontend имеет unit tests, component tests и Playwright/Cypress E2E основного пользовательского потока;
- [ ] frontend script больше не использует заглушку `no unit tests yet` как успешную test-команду;
- [ ] accessibility, loading/empty/error states и responsive layout проверены автоматически.

#### P2. Функции после закрытия MVP gate

- [ ] принято отдельное продуктовое решение по `POST_ONLY` и amend/replace order;
- [ ] принято отдельное продуктовое решение по disconnect cancel policy;
- [ ] при необходимости добавлены candles/OHLCV и portfolio valuation как независимые projections;
- [ ] добавлены CSV/export history и пользовательские fill/cancel/reject notifications;
- [ ] создан operational admin dashboard для lag, reconciliation, controls и incident actions;
- [ ] каждая новая order policy имеет contracts, deterministic matching tests, risk analysis и backward-compatibility plan.

Следующие возможности не входят в текущий training spot MVP и не могут быть
добавлены обычным feature PR без отдельного business scope, threat model, ADR и
regulatory/security программы:

- [ ] реальные fiat/crypto deposits и withdrawals, custody и wallet management;
- [ ] KYC/AML, sanctions screening и персональные документы;
- [ ] margin, leverage, borrowing и liquidation;
- [ ] derivatives, funding rate и expiry settlement;
- [ ] multi-region active-active matching и cross-region consensus;
- [ ] market-making или управление реальными клиентскими активами.

#### Порядок рефакторинга относительно бизнес-потока

- [ ] до крупного structural refactor создан failing/characterization black-box test полного торгового пути;
- [ ] сначала закрыт application orchestration gap, затем границы уточнены по фактическому runtime flow;
- [ ] `AdminService` разделён на command orchestration, dual control, policy registry и reconciliation;
- [ ] `MarketDataGateway` разделён на authentication, validation, subscription registry и safe error mapping;
- [ ] settlement разделён на reservation, fee policy, posting matrix и event orchestration;
- [ ] projections разделены на event appliers, pagination policy и rebuild coordinator;
- [ ] PostgreSQL adapters разделены на transaction orchestration, repositories и row/domain mappers;
- [ ] matching engine разделён на order book, price-level queue и execution/TIF policies без изменения deterministic output;
- [ ] JSDoc на русском описывает публичный контракт, инварианты и нетривиальные причины решений, но не заменяет декомпозицию крупного класса;
- [ ] после P0/P1 включён строгий blocking architecture guard из этапа 20.

Документация и автоматические проверки:

- [ ] обновлена C4/flow-схема фактического runtime, а не только целевой архитектуры;
- [ ] описаны command/order state transitions и различие acceptance/execution/finality;
- [ ] создан source event → consumer → projection/market-data mapping;
- [ ] описаны worker ownership, retry, offset, DLQ и recovery runbooks;
- [ ] OpenAPI/AsyncAPI отражают новые статусы, rejection codes, fills, fees и sequence metadata;
- [x] `ready:business` запускает black-box buyer/seller trade и reconciliation;
- [x] `ready:rc` и `ready:full` используют тот же production composition root и не подменяют critical ports;
- [ ] CI блокирует возврат прямых controller → domain/storage shortcuts;
- [ ] load/chaos/capacity tests измеряют реальный integrated hot path, включая accepted-to-settled и accepted-to-visible latency.

**Gate:** две встречные заявки, отправленные через публичный API production-like
staging, детерминированно создают одну сделку, полный сбалансированный settlement,
согласованные projections и изолированные WebSocket events. Повтор, restart и
частичный отказ не создают потерю или второй эффект. Только после закрытия этого
gate проект считается функциональным spot MVP, а результаты этапов 16–19 могут
использоваться как доказательство производительности и production readiness.

### Этап 22. Пользовательская authentication, Redis sessions и управление identity

**Цель:** заменить текущую вспомогательную API-key модель полноценной
пользовательской авторизацией, не смешивая human sessions, machine credentials и
test bypass. Пользовательские сессии должны быть управляемыми по отдельности,
а чувствительные данные не должны попадать в idempotency store, логи,
projections, responses или artifacts.

#### Модель доступа и границы

- [x] human users используют email+password и серверные Redis-backed sessions;
- [x] API keys остаются отдельным machine-to-machine механизмом со scopes, expiry, rotation и owner metadata;
- [x] API key secret показывается только один раз, хранится только как digest и не сохраняется в `public_result` idempotency;
- [x] публичные auth DTO не раскрывают password hash, session token, API key secret, internal roles или Redis keys;
- [x] authorization проверяет role, scope, owner/object access и session state на каждом protected endpoint;
- [x] in-memory auth/session stores запрещены в staging/production и доступны только для unit/component tests;
- [x] startup блокируется, если production-like профиль запущен без Redis session store, password hashing secret/pepper policy или secure cookie/token configuration;
- [x] все новые публичные interfaces, guards, DTO, controllers и services имеют подробный JSDoc на русском языке с принципом работы, инвариантами и примерами.

#### Registration, login и session lifecycle

- [x] добавлен `POST /api/v1/auth/register` для регистрации по email+password с нормализацией email и case-insensitive uniqueness;
- [x] добавлен `POST /api/v1/auth/login` с выдачей server session и безопасным public profile response;
- [x] добавлен `POST /api/v1/auth/logout` для завершения текущей сессии;
- [x] добавлен `POST /api/v1/auth/logout-all` или эквивалент для завершения всех сессий пользователя;
- [x] добавлен `GET /api/v1/auth/me` для получения текущего пользователя и активных authorization capabilities;
- [x] добавлены endpoints email verification и password reset/change recovery без раскрытия существования email;
- [x] password hash использует утверждённый adaptive алгоритм, per-password salt и конфигурируемый pepper/secret вне Git;
- [x] login/register/reset имеют rate limit, brute-force protection, audit events и enumeration-resistant errors;
- [x] session fixation предотвращается ротацией session id после login, privilege change и password change;
- [x] refresh/sliding TTL, absolute TTL, idle timeout и max sessions per user заданы конфигурацией и покрыты тестами.

#### Redis sessions

- [x] Redis является source of truth для активных пользовательских сессий и позволяет отозвать одну конкретную сессию;
- [x] session record хранит `sessionId`, `userId`, roles/scopes, auth level, createdAt, lastSeenAt, expiresAt, revokedAt, device metadata и correlation metadata;
- [x] bearer/cookie token хранится у клиента как opaque random value, а в Redis/logs/artifacts не сохраняется raw token;
- [x] Redis keys имеют namespace, TTL, bounded value size и не содержат email, token, accountId или другие чувствительные значения в открытом виде;
- [x] Redis подключается с AUTH/ACL, TLS там, где доступно, отдельной role и запретом dangerous commands для application user;
- [x] Redis outage переводит readiness/admission auth-зависимых операций в documented degraded mode, но не ломает liveness;
- [x] session lookup имеет bounded timeout/cache policy и не создаёт unbounded нагрузку на Redis при retry/reconnect storm;
- [x] revoke текущей, одной выбранной и всех сессий пользователя проверен после restart и при нескольких backend replicas.

#### User profile self-service

- [x] добавлен `PATCH /api/v1/users/me` для изменения `name` с validation, audit и безопасным response DTO;
- [x] добавлен `POST /api/v1/users/me/password` для смены password с проверкой current password или re-auth policy;
- [x] после смены password пользователь может завершить все остальные сессии, а security event фиксируется в audit;
- [x] добавлены `GET /api/v1/users/me/sessions` и `DELETE /api/v1/users/me/sessions/{sessionId}` для управления собственными сессиями;
- [x] пользователь не может менять role, ownerId, accountId, email verification state или security flags через self-service endpoints.

#### Admin session control

- [x] добавлены admin endpoints для просмотра active/revoked sessions пользователя без раскрытия raw token;
- [x] admin может отозвать одну сессию, все сессии пользователя и принудительно потребовать password reset;
- [x] admin не может прочитать или выставить password/API key/session token вручную;
- [x] session revoke, freeze/unfreeze, forced logout и password reset требуют role/object authorization, reason, audit metadata и idempotency key;
- [x] критичные admin actions используют dual-control policy там, где это требуется risk model;
- [x] admin session actions видны в audit trail и в operational logs без персональных и credential payloads.

#### Test auth bypass для продуктовых флоу

- [x] добавлен явный test-only механизм, например `X-Test-Auth-Token`, чтобы прогонять business/API flows без реального login;
- [x] test token работает только при `NODE_ENV=test` или отдельном isolated test profile и отдельном `AUTH_TEST_BYPASS_ENABLED=true`;
- [x] startup падает, если test bypass включён в development-compose для обычной ручной работы, staging, production или release-candidate profile;
- [x] test token задаётся через secret/env, не коммитится в Git, сравнивается с digest/timing-safe policy и не попадает в Swagger production docs;
- [x] test token мапится только на заранее описанные test identities/scopes и не позволяет прокинуть произвольный `userId`, role или accountId из header;
- [x] каждое использование test bypass пишет отдельный safe log/metric event и не создаёт audit-записи, похожие на реальные пользовательские действия;
- [x] CI проверяет, что production build не содержит активного bypass route/guard и что protected endpoints без валидной auth возвращают 401/403.

#### Security, privacy и hardening

- [x] cookies используют `HttpOnly`, `Secure`, `SameSite`, path/domain policy и CSRF protection, если выбран cookie transport;
- [x] CORS, body size, slow request, credential stuffing и connection exhaustion настроены для auth endpoints отдельно;
- [x] все auth errors возвращают стабильные public error codes и correlationId без stack trace, Redis errors, password policy internals и credential hints;
- [x] персональные данные и security events имеют retention policy, data minimization и redaction в logs/metrics/traces;
- [x] email, name, device metadata и IP/User-Agent обрабатываются как персональные данные и не используются как unbounded metric labels;
- [x] password reset, email verification, session revoke и API key rotation имеют replay protection и bounded expiry;
- [x] auth threat model обновлён для session hijacking, fixation, CSRF, XSS token theft, credential stuffing, replay, Redis compromise и insider/admin abuse.

#### Тесты и проверки

- [x] positive/negative tests покрывают register, login, logout, logout-all, me, password change, profile update и session revoke;
- [x] contract tests проверяют OpenAPI auth endpoints, DTO, error codes и отсутствие неизвестных полей;
- [x] Redis integration tests проверяют TTL, revoke одной сессии, revoke всех сессий, restart, replica concurrency и Redis outage;
- [x] security tests проверяют brute-force limit, enumeration resistance, CSRF, session fixation, replay, stale session и privilege change;
- [x] admin tests проверяют role matrix, object authorization, idempotency, audit completeness и запрет чтения raw credentials;
- [x] test bypass tests подтверждают работу в isolated test profile и невозможность включения в staging/production/release-candidate;
- [x] canary secret tests подтверждают, что password, API key, session token, reset token и Redis connection string не попадают в response/logs/artifacts/idempotency store;
- [x] migration tests создают users, credentials, sessions metadata и API key digests без сохранения plaintext secrets.

#### Документация

- [x] обновлены OpenAPI и каталог endpoints auth/users/admin sessions;
- [x] создан `docs/security/authentication.md` с flows register/login/logout/session revoke/password change;
- [x] описаны Redis session schema, TTL, revoke semantics, degraded mode и operational runbook;
- [x] описаны различия human session, API key и test-only bypass;
- [x] обновлён threat model Gateway/Auth и checklist ручного тестирования в test console;
- [x] приведены безопасные request/response examples без реальных credentials и без reusable tokens.

**Gate:** пользователь может зарегистрироваться, войти, управлять профилем и
точечно завершать сессии; админ может безопасно контролировать сессии без
доступа к секретам; тестовые флоу могут использовать explicit test token только
в изолированном тестовом профиле. Production-like окружение не содержит auth
bypass, не хранит plaintext credentials и блокирует запуск без Redis-backed
session store и проверенных security controls.
