# Event log adapter

## Observability boundary

Append сохраняет W3C carrier вместе с event metadata. Consumer восстанавливает
remote parent в `event_log.consume`, поэтому retry/restart не разрывает trace до
projection. Payload события не становится span attribute.

Модуль предоставляет in-memory adapter для component tests и PostgreSQL
transactional outbox для production-like runtime. Каждое событие имеет
`eventId`, `eventType`, correlation/causation metadata и JSON payload. Consumer
атомарно хранит processed event и offset вместе с business effect.

Решение о durable transport и границах транзакций зафиксировано в
[ADR-0006](../../../../../docs/adr/0006-postgresql-transactional-outbox.md).
Publisher допускает at-least-once delivery после crash и требует downstream
deduplication по `eventId`.

Для системной recovery-проверки adapter поддерживает `createArchive`,
`retainLatest` и `EventLog.restore`. Архив содержит format version, committed
consumer offset, события и SHA-256 checksum. Retention разрешён только после
подтверждённого сохранения архива во внешнее durable storage.

## Operational log events

`event-log.appended`, `event-log.consumed`, `event-log.timeout`,
`event-log.dead-lettered` и `event-log.recovered` связываются через event ID,
correlation/causation IDs. Payload события в operational log не попадает.

## Retry, DLQ и operator replay

Publisher хранит bounded exponential delay и безопасный error class. Consumer
после bounded attempts переносит poison event в `dead_letter_events` и двигает
offset в той же transaction. Replay создаёт новое событие с causation ID;
исходная DLQ-запись остаётся неизменной. Схема и recovery semantics описаны в
[`docs/durable-runtime.md`](../../../../../docs/durable-runtime.md).
