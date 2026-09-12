# Event log adapter

## Observability boundary

Append сохраняет W3C carrier вместе с event metadata. Consumer восстанавливает
remote parent в `event_log.consume`, поэтому retry/restart не разрывает trace до
projection. Payload события не становится span attribute.

Append-only adapter для событий settlement. Каждое событие имеет `eventId`, `eventType` и payload; consumer хранит offset и повторяет обработку до передачи poison-события в DLQ.

Все публичные методы и типы сопровождаются русскими JSDoc-комментариями. Production-реализация должна заменить in-memory хранилище на durable log/outbox согласно [ADR 0003](../../../../../docs/adr/0003-settlement-log-first.md).

Для системной recovery-проверки adapter поддерживает `createArchive`,
`retainLatest` и `EventLog.restore`. Архив содержит format version, committed
consumer offset, события и SHA-256 checksum. Retention разрешён только после
подтверждённого сохранения архива во внешнее durable storage.

## Operational log events

`event-log.appended`, `event-log.consumed`, `event-log.timeout`,
`event-log.dead-lettered` и `event-log.recovered` связываются через event ID,
correlation/causation IDs. Payload события в operational log не попадает.
