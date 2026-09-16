# Durable runtime: ownership и источники истины

Документ описывает реализованную persistence-модель первой части этапа 17A.
Command journal, HTTP idempotency, ledger, settlement outbox, consumer offsets,
DLQ и audit имеют PostgreSQL adapters. Локальный development compose остаётся
`component` topology; production compose запускает PostgreSQL и migrations и не
имеет права использовать in-memory state. Lease/fencing, snapshot recovery,
durable admission controls и versioned projections реализованы миграцией `003`;
fault-proxy topology относится к следующему подразделу 17A.

## Ownership catalog

| Данные | Source of truth | Владелец записи | Consistency / восстановление |
| --- | --- | --- | --- |
| Commands и status | PostgreSQL command journal | trading admission/sequencer | strong в command transaction; replay по sequence |
| Idempotency | PostgreSQL idempotency records | boundary, принявший command | unique identity + key, payload hash и public result |
| Orders | PostgreSQL order state + ordered events | trading state machine | один writer на instrument, fencing epoch |
| Accounts/balances | PostgreSQL ledger tables | ledger | row locks и atomic posting transaction |
| Postings/operations | append-only PostgreSQL ledger | ledger | immutable, balanced set, unique operationId |
| Outbox/events | PostgreSQL append-only outbox | producer transaction | eventId unique; at-least-once delivery |
| Consumer offsets | PostgreSQL consumer checkpoint | конкретный consumer | commit вместе с business/read-model effect |
| Projections | versioned PostgreSQL read models | projections consumer | eventual; rebuild из event log |
| Snapshots | PostgreSQL/object storage | sequencer/state machine | cache replay с checksum/version/boundary offset |
| Audit | append-only PostgreSQL + WORM replica | admin/audit boundary | tamper-evident chain, отдельные write grants |

## Разрешённые зависимости

Controllers и application services получают только ports через DI tokens:
`TRADING_COMMAND_PORT`, `IDEMPOTENCY_STORE_PORT`, `LEDGER_PORT`,
`EVENT_LOG_PORT`, `PROJECTION_STORE_PORT`, `AUDIT_LOG_PORT`,
`SEQUENCER_STORE_PORT` и `ADMISSION_CONTROL_PORT`. Интерфейсы выражают use cases
(`reserve`, `append`, `apply`), а не методы PostgreSQL или broker SDK.
Infrastructure adapter может импортировать client library; обратный импорт из
domain/application слоя запрещён.

In-memory реализации разрешены только при `RUNTIME_PROFILE=component`. Этот
профиль покрывает unit/component tests и локальный reference compose и не даёт
durability-гарантий. `staging` и `production` требуют явных значений:

```dotenv
RUNTIME_PROFILE=production
COMMAND_STORE_ADAPTER=postgres
LEDGER_STORE_ADAPTER=postgres
EVENT_LOG_ADAPTER=postgres-outbox
IDEMPOTENCY_STORE_ADAPTER=postgres
AUDIT_STORE_ADAPTER=postgres
SEQUENCER_STORE_ADAPTER=postgres
PROJECTION_STORE_ADAPTER=postgres
ADMISSION_CONTROL_ADAPTER=postgres
```

Проверка выполняется дважды. Env validation запрещает `memory` в
production-like profile. Затем startup guard сравнивает заявленные adapters с
фактическими NestJS providers. Поэтому простое изменение env не выдаёт reference
класс за durable implementation: до подключения repositories процесс завершится
ошибкой и не откроет HTTP admission.

## Запрещённые обходы

- возвращать `accepted` до commit command journal;
- менять balance прямым repository CRUD без ledger operation;
- публиковать событие отдельным dual write после ledger commit;
- продвигать offset до commit consumer effect;
- использовать snapshot или projection как финансовый source of truth;
- включать memory adapter в staging/production через fallback;
- передавать наружу database rows, aggregate или broker payload вместо public DTO.

## Durable admission algorithm

1. Gateway формирует scope `identity:idempotency-key`. В БД сохраняется SHA-256
   digest ключа: исходный header не попадает в journal, logs или outbox.
2. `PostgresIdempotencyStore` вставляет `PENDING` по unique key
   `(identity_key, key_digest)`. Конкурентный запрос ждёт исходную transaction,
   после чего получает прежний `APPLIED` result либо безопасный conflict.
3. `PostgresTradingCommandAdapter` берёт advisory transaction lock по
   `instrumentId`, назначает следующий sequence и записывает payload hash.
4. Database triggers разрешают только монотонные переходы и автоматически
   добавляют `ACCEPTED`, `PROCESSING`, `APPLIED|REJECTED|RECOVERY` в immutable
   lifecycle history. Terminal status изменить нельзя.
5. Public result, command state, idempotency result и outbox event commit-ятся
   вместе. Promise завершается только после `COMMIT`; исключение до commit
   откатывает все строки.

Повтор после restart создаёт новый instance adapter, читает committed public
result и не вызывает business callback. Повтор ключа с другим payload получает
`IDEMPOTENCY_KEY_REUSED`. Transient SQLSTATE `40001`, `40P01`, `55P03`
повторяют всю transaction максимум три раза с bounded exponential backoff и
jitter до 100 ms. Остальные ошибки не retry-ятся.

## Ledger transaction и ограничения

`PostgresLedgerAdapter` блокирует operation через advisory lock и balance rows
в стабильном порядке. Одна transaction содержит:

- изменение `available`/`reserved` с условным SQL predicate;
- две равные разнонаправленные postings для одного asset;
- immutable `ledger_operations` result для повторного `operationId`;
- reservation либо ссылку `compensation_for`, если применимо.

`NUMERIC(78,18)` и domain `Decimal` исключают floating point. CHECK constraints
запрещают отрицательные остатки и некорректный remaining reserve. Deferred
constraint trigger перед commit группирует postings по operation/asset и
отклоняет несбалансированный набор. UPDATE/DELETE postings запрещены trigger;
компенсация всегда создаёт новую operation и не стирает оригинал.

SELL reserve base и fee выполняется через `PostgresAtomicExecution`: отказ
второго reserve откатывает первый. Settlement тем же способом объединяет полный
posting matrix и `SettlementApplied`. `TradeExecuted` хранит decimal values как
строки; consumer восстанавливает `Decimal`, а malformed payload проходит
bounded retry и quarantine вместо финансовой мутации.

## Outbox, consumer и recovery

`outbox_events.event_id` уникален. Повтор того же ID с другим type/payload
отклоняется как `EVENT_ID_REUSED`. Publisher выбирает committed backlog через
`FOR UPDATE SKIP LOCKED`, ставит `published_at` только после acknowledgement и
хранит attempts, next attempt и безопасный error class. Crash между delivery и
commit означает допустимую повторную доставку, поэтому downstream использует
event ID для дедупликации.

Consumer фиксирует business callback, `processed_events` и
`consumer_offsets.committed_offset` в одной transaction. Ошибка откатывает все
три эффекта. После исчерпания attempts исходный payload копируется в DLQ с
source offset; operator replay создаёт новое causally-linked событие и не
редактирует исходную строку.

## Audit, retention и migrations

Audit append сериализован advisory lock. SHA-256 цепочка включает sequence,
actor, action, target, details и previous hash. Trigger запрещает UPDATE/DELETE,
а default retention равен семи годам. Operational logger не заменяет этот
бизнес-контракт. Отдельная production database role и WORM replica остаются
обязательными незакрытыми deployment controls: приложение под owner/superuser
не считается достаточным разделением прав.

Migration `001` создаёт базовые ledger tables, `002` — durable runtime. Down для
пустой тестовой схемы обратим; при наличии ledger operations или audit records
он завершается ошибкой `forward-only data policy`. В production такие данные
сначала архивируются и сверяются по runbook, а изменение выполняется новой
forward migration. Integration suite проверяет наложение `002`, down/up и
сохранность ранее созданного account balance.

## Проверка

Реальный PostgreSQL suite запускается так:

```bash
POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:5432/exchange \
  pnpm --filter @exchange/backend exec jest \
  src/modules/ledger/infrastructure/postgres.int-spec.ts --runInBand
```

Suite проверяет concurrent duplicate, restart, rollback до commit, constraints,
reserve, settlement/outbox, consumer offset, DLQ, tamper detection и migration
compatibility. Пропуск теста без `POSTGRES_URL` допустим только в component test
run; production-like CI обязан передать URL настоящего PostgreSQL.

## Partition lease, fencing и recovery

`partition_leases` содержит единственного owner, deadline и возрастающий
`fencing_epoch`. Любая запись sequence/snapshot блокирует lease row и сравнивает
owner, epoch и deadline. После transfer старый процесс получает
`STALE_FENCING_TOKEN`, даже если ещё выполняет старый callback.

Полное архитектурное решение, рассмотренные альтернативы и границы проверки
зафиксированы в [ADR-0007](adr/0007-partition-lease-fencing.md).

Transfer закрывает admission и переводит partition в `RECOVERING`. Новый owner
загружает snapshot поддерживаемой версии, пересчитывает checksum канонического
JSON и replay-ит command journal от `lastSequence + 1` до durable high
watermark. Gap, неизвестная версия или неверный checksum блокируют открытие
admission. Snapshot содержит instrument, version, sequence, boundary outbox
offset, epoch и payload; in-flight commands запрещают его создание.

Graceful shutdown ставит `DRAINING`, закрывает admission, проверяет отсутствие
in-flight work и освобождает lease. При аварийной остановке lease остаётся до
bounded expiry, после чего новый owner получает больший fencing epoch. Epoch
дублируется в durable partition state и поэтому не сбрасывается после удаления
lease при штатной передаче.

## Durable operational controls

Admin и Gateway используют один `ADMISSION_CONTROL_PORT`. После authorization и
dual-control approval Admin записывает current state и immutable history;
Gateway проверяет policy до idempotency callback и command append. Поддерживаются
global circuit breaker, user/account freeze, instrument pause и явный `ALLOW`
как компенсирующий resume/unfreeze. Каждая запись содержит command ID, actor,
reason, effectiveAt и монотонную version.

Production adapter читает PostgreSQL на каждом admission request, поэтому после
restart нет окна с пустым локальным cache. Ошибка control store не должна
трактоваться как разрешение команды.

## Versioned projections

Live consumer одной транзакцией изменяет read model, вставляет processed event
ID и двигает applied sequence. Duplicate пропускается, а gap откатывает всю
transaction. Rebuild создаёт shadow version `BUILDING`, применяет полный ordered
stream и одним commit переводит прежнюю version в `RETIRED`, новую — в `ACTIVE`.
Query API читает только ACTIVE version и сохраняет owner filtering.

## Readiness

Production readiness регистрирует PostgreSQL, outbox/event-log, partition lease
и admission-control как critical dependencies. Probe — bounded read-only
`SELECT`; deadline задаётся `DEPENDENCY_PROBE_TIMEOUT_MS`, общий SQL timeout —
`POSTGRES_QUERY_TIMEOUT_MS`. Liveness не делает сетевых вызовов. Observability
exporter изолирован и не является critical readiness dependency.
