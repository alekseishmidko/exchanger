# Event log adapter

Append-only adapter для событий settlement. Каждое событие имеет `eventId`, `eventType` и payload; consumer хранит offset и повторяет обработку до передачи poison-события в DLQ.

Все публичные методы и типы сопровождаются русскими JSDoc-комментариями. Production-реализация должна заменить in-memory хранилище на durable log/outbox согласно [ADR 0003](../../../../../docs/adr/0003-settlement-log-first.md).
