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
14. [ ] единое structured logging во всех модулях и transport/application boundaries.
15. [ ] observability: metrics, traces, dashboards, alerts и проверяемые SLO.
16. [ ] реалистичное HTTP/WebSocket/processing нагрузочное тестирование.
17. [ ] resilience, chaos и восстановление при деградации зависимостей.
18. [ ] adversarial, fuzz, race и нестандартные граничные сценарии.
19. [ ] capacity planning и итоговая production-readiness qualification.

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

- [ ] определены SLI/SLO для availability, command acceptance, settlement correctness, market-data freshness и projection lag;
- [ ] OpenTelemetry context распространяется через HTTP, WebSocket, command envelope, event log и consumers;
- [ ] spans покрывают admission, sequencer wait, matching, settlement, ledger commit, event append и projection apply;
- [ ] RED metrics покрывают REST/WebSocket, USE metrics — runtime, PostgreSQL, pools, event loop и consumers;
- [ ] бизнес-метрики отражают accepted/rejected orders, trades, settlement failures, reconciliation differences, gaps и circuit breaker state;
- [ ] histogram buckets соответствуют latency budgets и позволяют вычислять p50/p95/p99;
- [ ] labels не содержат userId, orderId, commandId и другие unbounded значения;
- [ ] установлены cardinality limits и защита от telemetry overload;
- [ ] logs связаны с traces через traceId/spanId, metrics — через exemplars где возможно;
- [ ] exporter имеет bounded queue/timeout и не блокирует торговый hot path;
- [ ] readiness не зависит от доступности observability backend;
- [ ] dashboards и alert rules версионируются и проверяются автоматически.

Тесты и эксплуатационная проверка:

- [ ] integration test подтверждает непрерывный trace полного command flow;
- [ ] metric contract tests проверяют имена, типы, единицы и разрешённые labels;
- [ ] cardinality test с уникальными IDs не создаёт неограниченные series;
- [ ] exporter failure не останавливает приложение и отражается internal metric;
- [ ] synthetic traffic переводит каждый alert в firing и обратно в resolved;
- [ ] dashboards проверены на пустом, нормальном и деградировавшем окружении;
- [ ] каждый alert содержит owner, severity, runbook URL и diagnostic context;
- [ ] измерены ingestion volume, retention и допустимая потеря non-critical telemetry.

Документация:

- [ ] созданы `docs/observability/metrics.md`, `tracing.md`, `slo.md` и `alerts.md`;
- [ ] зафиксированы dashboard catalog, ownership и escalation policy;
- [ ] описано различие client error, saturation, dependency failure и invariant violation;
- [ ] добавлен observability blackout runbook.

**Gate:** дежурный инженер обнаруживает и локализует проблему от клиентского
запроса до зависимости без подключения отладчика.

### Этап 16. Реалистичное нагрузочное тестирование

**Контуры:** REST command/query API, WebSocket streams, sequencer, matching,
settlement, ledger, event log, PostgreSQL и projections.

Профили и данные:

- [ ] выбран и зафиксирован нагрузочный runner; для HTTP/WebSocket сценариев базовым кандидатом является k6;
- [ ] нагрузочные сценарии находятся в версионируемом `tests/load/` и используют общие flow/data builders;
- [ ] реализованы smoke, average, stress, spike, soak и breakpoint profiles;
- [ ] workload моделирует чтение, place/cancel, partial/multi-fill, private/public subscriptions и reconnect;
- [ ] распределение инструментов, аккаунтов, Side/OrderType/TIF и размеров заявок похоже на ожидаемый production traffic;
- [ ] hot instrument и равномерно распределённые instruments тестируются отдельно;
- [ ] IDs/idempotency keys уникальны, а test data очищается или изолируется по runId;
- [ ] тест выполняется с реальными PostgreSQL/event-log adapters, TLS и сетевыми hop;
- [ ] генератор нагрузки запущен отдельно от system under test и сам не является bottleneck;
- [ ] hardware, topology, dataset size, build SHA и configuration сохраняются с результатом.

Метрики и автоматизация:

- [ ] заданы thresholds для throughput, error rate, p50/p95/p99/max и timeout rate;
- [ ] фиксируются consumer/projection lag, event-loop lag, CPU, memory, GC, pool usage, DB locks и network throughput;
- [ ] измеряется accepted-to-settled и accepted-to-visible latency, а не только HTTP response time;
- [ ] quick smoke/average profile запускается в CI, полный stress/soak — по расписанию и перед release;
- [ ] regression budget сравнивает результат с baseline на сопоставимом окружении;
- [ ] failed thresholds завершают pipeline с ненулевым кодом;
- [ ] raw results, trend graphs и GitHub summary сохраняются как artifacts;
- [ ] после теста выполняются reconciliation и проверка отсутствия потерянных/повторных эффектов.

Документация:

- [ ] создан `docs/testing/load-testing.md` с профилями и командами запуска;
- [ ] описаны target workload, допущения и различие Pilot baseline от production SLA;
- [ ] результаты имеют дату, build SHA, environment и ссылку на artifacts;
- [ ] зафиксированы найденные bottlenecks, владельцы и план устранения.

**Gate:** система выдерживает целевой average и peak profile в рамках SLO, после
нагрузки сходится reconciliation, а деградация имеет измеренную безопасную форму.

### Этап 17. Resilience, chaos и восстановление под нагрузкой

Цель — проверить не только скорость исправной системы, но и сохранение денежных,
ordering и idempotency-инвариантов во время частичных отказов.

Сценарии:

- [ ] fault injection разрешён только в изолированном test/staging окружении;
- [ ] проверены latency, timeout, reset и packet loss для PostgreSQL, event log и внешних adapters;
- [ ] проверены pool exhaustion, deadlock, lock contention и временная read-only БД;
- [ ] проверены consumer crash до/после commit, duplicate delivery, gap и poison event;
- [ ] process/container kill выполняется во время place, match, settlement и projection apply;
- [ ] rolling restart не нарушает partition ownership и monotonic sequence;
- [ ] retry storm, reconnect storm и thundering herd не обходят rate/backpressure limits;
- [ ] WebSocket slow consumers и массовый reconnect не влияют на matching latency;
- [ ] disk pressure, memory pressure и event-loop stall приводят к контролируемой деградации;
- [ ] clock skew и leap/timezone boundaries не меняют deterministic ordering/effectiveAt policy;
- [ ] observability backend outage не блокирует business flow;
- [ ] circuit breaker, pause и recovery transitions проверены под продолжающейся нагрузкой.

Проверки результата:

- [ ] ни одна accepted command не потеряна и не применена дважды;
- [ ] sequence, ledger balance и immutable audit trail остаются корректными;
- [ ] readiness отражает деградацию и не маскирует отказ критичной зависимости;
- [ ] backlog после восстановления уменьшается, а не растёт бесконечно;
- [ ] практически измерены RTO/RPO для каждого класса отказа;
- [ ] reconciliation автоматически выполняется после каждого chaos scenario;
- [ ] failure не создаёт утечку stack trace, credential или private event;
- [ ] сценарии детерминированы, имеют seed/timeline и сохраняют artifacts.

Документация:

- [ ] failure matrix содержит injection method, expected behavior, alert и owner;
- [ ] обновлены recovery/replay, dependency outage и reconciliation runbooks;
- [ ] описаны stop conditions, blast-radius limits и emergency abort chaos-тестов;
- [ ] результаты game day подписаны участниками и содержат follow-up actions.

**Gate:** при отказе одной критичной зависимости система либо продолжает работу в
заявленном degraded mode, либо безопасно прекращает admission без потери принятой
команды и без нарушения финансовых инвариантов.

### Этап 18. Adversarial и нестандартные граничные сценарии

Входные данные и протоколы:

- [ ] property-based/fuzz tests генерируют команды, события и последовательности операций с воспроизводимым seed;
- [ ] проверены пустые, oversized, deeply nested, truncated и malformed JSON payloads;
- [ ] проверены Unicode normalization, control characters, duplicate JSON keys и необычные identifiers;
- [ ] decimal tests покрывают ноль, максимальную точность, очень большие значения, ведущие нули, exponent, NaN/Infinity и rounding boundaries;
- [ ] timestamps покрывают прошлое/будущее, одинаковый effectiveAt, clock rollback и timezone/DST boundaries;
- [ ] pagination проверена при параллельном добавлении данных, stale/tampered cursor и изменении projection version;
- [ ] REST/WebSocket protocol fuzzing не приводит к uncaught exception или process crash;
- [ ] неизвестная версия/тип сообщения отклоняется либо обрабатывается по compatibility policy.

Гонки и злоупотребления:

- [ ] проверены concurrent duplicate place, cancel-vs-match, freeze-vs-place и pause-vs-admission;
- [ ] settlement-vs-retry и projection rebuild-vs-live delivery дают exactly-once business effect;
- [ ] один idempotency key с разными payloads/identities всегда конфликтует;
- [ ] hot-key, hot-instrument и skewed partition не приводят к starvation остальных partitions;
- [ ] rate-limit bypass через reconnect, headers, API keys и distributed clients закрыт;
- [ ] authorization isolation проверена массовой матрицей users/accounts/orders/subscriptions;
- [ ] WebSocket subscription churn, invalid ack ordering и sequence wrap/large values обработаны безопасно;
- [ ] zip/decompression bomb, slow request и connection exhaustion ограничены transport configuration;
- [ ] любой unexpected input даёт документированный 4xx/protocol error, но не 500 и не утечку данных.

Автоматизация и документация:

- [ ] найденный fuzz/property failure сохраняется как минимальный regression fixture;
- [ ] nightly pipeline имеет ограничение времени, corpus retention и triage owner;
- [ ] security tools покрывают dependencies, container image, secrets, SAST и API threat model;
- [ ] создан `docs/testing/adversarial-cases.md` с каталогом классов входов и ожидаемыми outcomes;
- [ ] flaky race test не отключается без issue, owner и срока исправления.

**Gate:** некорректные, враждебные и конкурентные входы не нарушают isolation,
идемпотентность, ordering, денежные инварианты и доступность процесса.

### Этап 19. Capacity planning и production-readiness qualification

Capacity и длительная устойчивость:

- [ ] найден maximum sustainable throughput и saturation point каждого критического компонента;
- [ ] production target использует согласованный headroom для traffic burst и отказа одного instance/node;
- [ ] измерено влияние числа instruments, active orders, accounts, event history и projection size;
- [ ] отдельный soak test выявляет memory/handle/connection leaks и рост GC pause;
- [ ] проверены лимиты PostgreSQL connections, storage growth, indexes, WAL/event retention и archive throughput;
- [ ] autoscaling policy основана на causal metrics: queue/lag/CPU, а не только среднем CPU;
- [ ] scale-out/scale-in не нарушает partition ownership, ordering и WebSocket sessions;
- [ ] graceful shutdown завершает или безопасно передаёт accepted work;
- [ ] deploy/rollback совместимы с активными clients, предыдущей schema и in-flight events;
- [ ] стоимость инфраструктуры и telemetry оценена для average/peak/retention profiles.

Release qualification:

- [ ] black-box API flow pipeline проходит против release candidate environment;
- [ ] smoke, average, spike, soak, chaos, recovery и adversarial suites имеют зелёные отчёты;
- [ ] SLO/error budget и performance regression budgets соблюдены;
- [ ] backup/restore, archive/restore и region/node recovery проверены практически;
- [ ] dashboards, alerts и runbook links проверены дежурным инженером;
- [ ] открытые исключения имеют severity, owner, deadline и формальное risk acceptance;
- [ ] release report содержит build SHA, конфигурацию, результаты и решение go/no-go;
- [ ] rollback criteria и emergency stop rehearsed до production deployment.

Документация:

- [ ] создан `docs/operations/capacity-plan.md`;
- [ ] создан versioned production-readiness report template;
- [ ] определены владельцы SLO, capacity, on-call и release decision;
- [ ] baseline и trend history доступны для сравнения следующих releases.

**Финальный gate:** release допускается к production только при доказанной
устойчивости под целевой и аварийной нагрузкой, практически проверенном recovery и
отсутствии необъяснимых нарушений SLO или доменных инвариантов.
