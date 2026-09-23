# Trading command и order lifecycle

## Зачем это нужно

Биржа не должна смешивать факт durable acceptance с фактическим исполнением.
Команда может быть записана в journal, но ещё не применена matching engine,
ledger и projections. Поэтому публичный result всегда содержит три разных поля:

- `durableStatus` — состояние command journal;
- `executionStatus` — применён ли бизнес-эффект;
- `orderStatus` — состояние заявки.

## Command lifecycle

| From | To |
| --- | --- |
| `RECEIVED` | `ACCEPTED`, `REJECTED`, `RECOVERY_REQUIRED` |
| `ACCEPTED` | `PROCESSING`, `REJECTED`, `RECOVERY_REQUIRED` |
| `PROCESSING` | `APPLIED`, `REJECTED`, `RECOVERY_REQUIRED` |
| `RECOVERY_REQUIRED` | `PROCESSING`, `APPLIED`, `REJECTED` |
| `APPLIED` | terminal |
| `REJECTED` | terminal |

## Order lifecycle

| From | To |
| --- | --- |
| `PENDING` | `OPEN`, `PARTIALLY_FILLED`, `FILLED`, `REJECTED`, `CANCEL_PENDING` |
| `OPEN` | `PARTIALLY_FILLED`, `FILLED`, `CANCEL_PENDING`, `CANCELLED`, `REJECTED` |
| `PARTIALLY_FILLED` | `FILLED`, `CANCEL_PENDING`, `CANCELLED` |
| `CANCEL_PENDING` | `CANCELLED`, `REJECTED` |
| `FILLED` | terminal |
| `CANCELLED` | terminal |
| `REJECTED` | terminal |

Cancel не может перевести terminal order обратно в active состояние. Повтор
terminal cancel возвращает прежний terminal result или безопасный conflict, но
не создаёт новый business effect.

## Единые rejection codes

Source of truth находится в
`apps/backend/src/modules/trading/lifecycle/trading-lifecycle.ts`. REST,
WebSocket, OpenAPI, AsyncAPI, projections и audit должны использовать только эти
коды, чтобы клиент не писал разные обработчики для одного отказа.
