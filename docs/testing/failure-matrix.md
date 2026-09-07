# Failure matrix

Статус: accepted. Дата: 2026-09-08.

| Boundary / отказ | Ожидаемое поведение | Проверка |
| --- | --- | --- |
| Invalid environment | startup blocked | `environment.spec.ts` |
| PostgreSQL unavailable | readiness unavailable, liveness alive | `health.service.spec.ts` |
| Event log timeout | bounded retry, затем ошибка/DLQ | `event-log.spec.ts`, `settlement.spec.ts` |
| Consumer crash before commit | redelivery без второго business effect | `event-log.spec.ts` |
| Duplicate command/event | прежний result, нет второй проводки | state-machine/settlement/system E2E |
| Sequence/partition gap | admission blocked, требуется replay | sequencer/state-machine specs |
| Projection gap | read model не применяет out-of-order event | `projection.spec.ts` |
| Market-data gap | client resync из replay/snapshot | `market-data.spec.ts` |
| Slow WebSocket consumer | disconnect с backpressure code | `market-data.spec.ts` |
| Invalid/expired API key | безопасный 401 | `gateway.spec.ts` |
| Rate/fan-out limit | 429 либо bounded disconnect | gateway/market-data specs |
| Audit tampering | integrity=false, admin writes останавливаются по runbook | `admin.service.spec.ts` |
| PostgreSQL data loss | restore в отдельную DB, reconciliation | требует внешнего запуска backup/restore |

Failure injection не должна логировать секреты или менять исходные audit/event
records. Восстановление выполняется replay или compensation, а не исправлением
истории на месте.
