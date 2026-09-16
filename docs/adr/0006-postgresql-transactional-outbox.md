# ADR-0006: PostgreSQL command journal и transactional outbox

- Статус: принято
- Дата: 2026-09-15
- Владельцы: Trading Platform, Ledger

## Контекст

Reference runtime хранит команды, ledger, idempotency, события, offsets и audit
в памяти одного процесса. Такой контур полезен для детерминированных component
tests, но accepted response теряется после `SIGKILL`, а независимые обновления
ledger и event log создают окно частичного финансового эффекта.

Рассматривались Kafka/Redpanda как первичный журнал, PostgreSQL log/outbox и
отдельная распределённая event store. На текущем масштабе система является
модульным монолитом, а основной строгий инвариант — атомарность command state,
ledger postings, idempotency result и публикации события.

## Решение

PostgreSQL становится production source of truth. Команды сохраняются в command
journal, денежный эффект — в ledger tables, а предназначенные потребителям
события — в append-only outbox. Все три набора строк могут участвовать в одной
локальной ACID-транзакции. Outbox publisher читает committed строки через
`FOR UPDATE SKIP LOCKED`, публикует их downstream и идемпотентно отмечает delivery.

Kafka/Redpanda не является обязательной частью первой durable topology. При его
добавлении broker будет delivery/fan-out transport, а PostgreSQL outbox останется
границей, исключающей dual write. Consumer допускает at-least-once delivery;
exactly-once business effect достигается unique event/operation IDs и атомарной
фиксацией consumer effect вместе с offset.

## Transaction boundaries

1. Admission: idempotency key digest, payload hash и command journal row
   фиксируются одной транзакцией. `accepted` возвращается только после commit.
2. Ledger/settlement: balance locks, полный debit/credit posting set, operation
   record, settlement state и outbox rows фиксируются одной транзакцией.
3. Projection consumer: read-model mutation, processed event ID и consumer offset
   фиксируются одной транзакцией. Crash до commit повторяет всё; crash после
   commit видит duplicate и не повторяет effect.
4. Outbox delivery не входит в финансовую транзакцию. Publisher может отправить
   событие повторно между broker acknowledgement и отметкой delivery; eventId
   делает повтор безопасным.
5. Audit append и durable control history содержат общий command ID, actor и
   reason для reconciliation. Сейчас это две последовательные durable boundary;
   объединение их в одну PostgreSQL transaction либо transactional outbox для
   audit является обязательным до заявления atomic audit/control effect.
   Последующая WORM-репликация остаётся отдельным deployment control.

Транзакции одного инструмента используют monotonic sequence и fencing epoch.
Ledger блокирует строки в стабильном порядке `(asset_id, account_id)`, чтобы
уменьшить deadlock; bounded retry разрешён только для serialization/deadlock.

## Consistency model

- commands, idempotency, ledger и outbox имеют strong consistency внутри commit;
- orders восстанавливаются из command/event state и sequence;
- projections, WebSocket и внешние broker consumers имеют eventual consistency;
- audit является append-only и tamper-evident;
- snapshot — ускоритель replay, но не source of truth.

## Последствия

Преимущество — отсутствие dual-write окна и возможность проверять RPO=0 на
одном транзакционном engine. Цена — нагрузка outbox/polling на PostgreSQL,
необходимость partition/retention и ограничение throughput одной instrument
partition. Переход к broker-first потребует отдельного ADR и доказательства
эквивалентной атомарности, а не простой замены adapter.

Production-like startup обязан явно выбрать `postgres`/`postgres-outbox` для
всех critical boundaries. Реализации зарегистрированы в composition root, а
declared/actual guard сравнивает конфигурацию с фактическими DI providers до
открытия HTTP admission. In-memory adapter в staging/production блокирует запуск.

## Migration policy

Структурно обратимые изменения проверяются migration down/up на пустых runtime
tables с сохранением данных базовой ledger schema. Ledger operations и audit
records считаются forward-only: down migration отказывается удалять непустые
таблицы. Исправление production data выполняется новой компенсирующей записью и
forward migration после reconciliation, но не ручным UPDATE/DELETE.
