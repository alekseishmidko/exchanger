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
7. [ ] `trading/settlement`: atomic trade settlement и fees.
8. [ ] `gateway`: authentication, validation, rate limits и command API.
9. [ ] `projections`: orders, trades и balances read-models.
10. [ ] `market-data`: public/private streams, snapshots и gap recovery.
11. [ ] `admin`: instrument configuration, limits, circuit breaker и audit.
12. [ ] нагрузочное, failure, security и recovery тестирование всей системы.

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

- [ ] instrument и trading pair;
- [ ] base/quote assets;
- [ ] tick size, lot size, min/max quantity;
- [ ] active/paused status;
- [ ] fee policy version;
- [ ] price bands и trading limits.

Тесты:

- [ ] точность цены и количества;
- [ ] invalid tick/lot values;
- [ ] instrument lifecycle;
- [ ] paused instrument;
- [ ] versioned rule effective time;
- [ ] invalid configuration cannot enter trading state.

Документация:

- [ ] README модуля;
- [ ] каталог правил инструмента;
- [ ] state diagram lifecycle;
- [ ] admin change audit requirements.

**Gate:** любая заявка может быть проверена относительно неизменяемой версии правил инструмента.

### Этап 5. Matching engine

**Модуль:** `trading/matching-engine`.

Состояние:

- [ ] bids/asks price levels;
- [ ] FIFO queue внутри price level;
- [ ] active orders;
- [ ] order status и remaining quantity;
- [ ] sequence последнего применения.

Правила:

- [ ] price-time priority;
- [ ] passive order price;
- [ ] partial fills;
- [ ] limit/market;
- [ ] GTC/IOC/FOK;
- [ ] cancel;
- [ ] self-trade prevention;
- [ ] deterministic result независимо от запуска.

Тесты:

- [ ] каждый сценарий из правил исполнения;
- [ ] empty book и single-level book;
- [ ] multi-level match;
- [ ] exact/partial/full fill;
- [ ] market остаток;
- [ ] IOC/FOK;
- [ ] cancel before/after match;
- [ ] same-price FIFO;
- [ ] self-trade prevention;
- [ ] property-based random order sequences;
- [ ] golden replay fixtures;
- [ ] benchmark без сетевых и DB вызовов.

Документация:

- [ ] README модуля;
- [ ] формальная таблица state transitions;
- [ ] Mermaid sequence diagrams;
- [ ] описание алгоритма и его сложности;
- [ ] каталог rejection codes;
- [ ] ADR о порядке price-time.

**Gate:** одинаковая последовательность команд всегда создаёт одинаковые events и итоговый order book.

### Этап 6. Sequencer и trading state machine

**Модули:** `trading/sequencer`, `trading/state-machine`.

- [ ] partition ownership по `instrument_id`;
- [ ] monotonic sequence;
- [ ] command admission;
- [ ] deduplication по command/idempotency key;
- [ ] deterministic clock policy;
- [ ] pause/resume instrument;
- [ ] snapshot boundary.

Тесты:

- [ ] две команды одного инструмента обрабатываются по порядку;
- [ ] разные инструменты могут обрабатываться независимо;
- [ ] повтор команды возвращает прежний результат;
- [ ] gap sequence обнаруживается;
- [ ] crash/restart восстанавливает sequence;
- [ ] pause блокирует новые команды по политике;
- [ ] replay даёт идентичное состояние;
- [ ] partition ownership failure tests.

Документация:

- [ ] README и state diagram;
- [ ] правила sequence и ordering;
- [ ] recovery/replay runbook;
- [ ] latency budget критического пути;
- [ ] описание backpressure.

**Gate:** нет двойного исполнения, нарушения порядка или потери принятой команды.

### Этап 7. Settlement и event log

**Модули:** `trading/settlement`, event-log adapter.

- [ ] reserve до размещения;
- [ ] settlement после match;
- [ ] maker/taker fees;
- [ ] `TradeExecuted` и `SettlementApplied`;
- [ ] durable append;
- [ ] consumer offset;
- [ ] retry и dead-letter policy.

Тесты:

- [ ] buy/sell settlement;
- [ ] maker/taker fee calculation;
- [ ] multi-fill settlement;
- [ ] insufficient balance;
- [ ] duplicate event;
- [ ] event log timeout;
- [ ] consumer crash before/after commit;
- [ ] ledger/event reconciliation;
- [ ] exactly-once business effect through idempotency.

Документация:

- [ ] settlement flow;
- [ ] posting matrix для каждой сделки;
- [ ] event log retention;
- [ ] outbox/log-first decision ADR;
- [ ] reconciliation и incident runbook.

**Gate:** каждая сделка даёт полный и проверяемый набор проводок и событий.

### Этап 8. Gateway и command API

**Модуль:** `gateway`.

- [ ] auth и API keys;
- [ ] DTO validation;
- [ ] command mapping;
- [ ] idempotency headers;
- [ ] rate limits;
- [ ] pagination и limits;
- [ ] безопасные error responses;
- [ ] REST endpoint для place/cancel.

Тесты:

- [ ] valid/invalid auth;
- [ ] role/object authorization;
- [ ] malformed payload;
- [ ] oversized payload;
- [ ] duplicate idempotency key;
- [ ] rate limit;
- [ ] timeout and retry;
- [ ] no sensitive data in errors;
- [ ] OpenAPI contract tests;
- [ ] API e2e до trading core.

Документация:

- [ ] OpenAPI;
- [ ] auth and API key guide;
- [ ] error code catalog;
- [ ] rate limit policy;
- [ ] request/response examples;
- [ ] security threat model Gateway.

**Gate:** внешний клиент не может обойти валидацию, авторизацию или idempotency.

### Этап 9. Projections и query API

**Модули:** `projections`.

- [ ] order history;
- [ ] trade history;
- [ ] balance projection;
- [ ] cursor pagination;
- [ ] rebuild from event log;
- [ ] projection version.

Тесты:

- [ ] projection каждого события;
- [ ] duplicate delivery;
- [ ] out-of-order/gap detection;
- [ ] rebuild equals live projection;
- [ ] pagination consistency;
- [ ] authorization data isolation;
- [ ] schema migration;
- [ ] lag metrics.

Документация:

- [ ] source event → projection mapping;
- [ ] read consistency policy;
- [ ] rebuild runbook;
- [ ] retention and indexing;
- [ ] query API contract.

**Gate:** проекции восстанавливаются из журнала и не показывают данные другого пользователя.

### Этап 10. Market data и WebSocket

**Модуль:** `market-data`.

- [ ] public order book snapshot;
- [ ] incremental updates;
- [ ] trades/ticker;
- [ ] private user stream;
- [ ] sequence/gap recovery;
- [ ] subscription authorization;
- [ ] fan-out limits.

Тесты:

- [ ] snapshot consistency;
- [ ] ordered increments;
- [ ] gap detection and resync;
- [ ] unauthorized private subscription;
- [ ] disconnect/reconnect;
- [ ] slow consumer/backpressure;
- [ ] burst fan-out;
- [ ] no private event leakage.

Документация:

- [ ] public/private channel catalog;
- [ ] WebSocket protocol;
- [ ] snapshot and replay algorithm;
- [ ] backpressure policy;
- [ ] client reconnection guide.

**Gate:** клиент может восстановить актуальный стакан после разрыва, не получая чужих данных.

### Этап 11. Admin, risk и audit

**Модули:** `admin`, `audit`.

- [ ] instrument configuration;
- [ ] fee/risk policy changes;
- [ ] user/account freeze;
- [ ] circuit breaker;
- [ ] audit events;
- [ ] dual control для критичных операций;
- [ ] reconciliation dashboard.

Тесты:

- [ ] role matrix;
- [ ] forbidden admin actions;
- [ ] freeze behavior;
- [ ] emergency stop;
- [ ] audit completeness;
- [ ] tamper detection;
- [ ] policy version effective time;
- [ ] administrative idempotency.

Документация:

- [ ] admin permission matrix;
- [ ] audit field catalog;
- [ ] emergency stop runbook;
- [ ] incident response runbook;
- [ ] risk policy and limits;
- [ ] retention policy.

**Gate:** критичные действия контролируются, аудируются и обратимы только компенсирующей операцией.

### Этап 12. Системная проверка

- [ ] полный E2E: account → balance → order → match → settlement → history;
- [ ] повтор всей команды не создаёт повторный эффект;
- [ ] restart/replay для trading core;
- [ ] PostgreSQL backup/restore;
- [ ] event log retention/archive/restore;
- [ ] failure matrix для всех критичных зависимостей;
- [ ] security review и threat model update;
- [ ] нагрузочный тест Pilot profile;
- [ ] WebSocket fan-out test;
- [ ] p50/p95/p99 и consumer lag зафиксированы;
- [ ] RTO/RPO проверены практически;
- [ ] все runbooks проверены человеком, не только написаны.

**Финальный gate:** требования, инварианты, тесты, документация и эксплуатационные процедуры согласованы; известные исключения оформлены ADR/issue с ответственным и сроком.
