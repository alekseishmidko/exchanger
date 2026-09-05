# Projections: mapping, consistency и recovery

## Source event → projection

| Source event | Read model effect |
| --- | --- |
| `OrderAccepted` | создаёт/обновляет order history со статусом `ACCEPTED` |
| `OrderRejected` | фиксирует terminal `REJECTED` status |
| `OrderCancelled` | фиксирует `CANCELLED` и remaining quantity |
| `TradeExecuted` | добавляет trade history для maker и taker |
| `SettlementApplied` | суммирует available/reserved deltas по account и asset |

## Read consistency

Query API является eventually consistent относительно event log. `appliedSequence` и `sourceSequence` доступны через `/metrics`; `lag > 0` означает отставание consumer. Duplicate events безопасны, gap блокирует применение до восстановления пропущенного диапазона.

## Rebuild runbook

1. Остановить consumer partition и сохранить `appliedSequence`/correlation ID.
2. Проверить gap и целостность event log.
3. Выполнить `rebuild` из полного упорядоченного журнала.
4. Сравнить metrics и контрольные выборки с live ledger/event reconciliation.
5. Возобновить consumer и проверить, что lag возвращается к нулю.

## Retention и indexing

Хранить projection rows не меньше срока event-log rebuild и audit retention. Production tables индексируются по `(user_id, sequence)`, trades — по `(user_id, sequence, trade_id)`, balances — уникально по `(account_id, asset_id)`. Старые rows архивируются только вместе с доступным source event log.

## Query contract

Каждый список ограничен `limit` от 1 до 100 и возвращает `{ items, nextCursor }`. Cursor opaque для клиента; invalid cursor/limit возвращает `PAGINATION_INVALID`. Авторизация выполняется до фильтрации и pagination.
