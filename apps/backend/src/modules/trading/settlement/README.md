# Settlement module

## Observability boundary

`trading.settlement.apply` содержит дочерние `ledger.commit` и
`event_log.append`. `exchange_settlement_total` разделяет applied и invariant
failure; финансовый payload и суммы не экспортируются в telemetry.

## Назначение

Settlement связывает `TradeExecuted` с ledger: резервирует средства до допуска заявки, после match переводит reserved base/quote, начисляет maker/taker fees и публикует `SettlementApplied`.

## Posting matrix

| Операция        | Debit                          | Credit                 |
| --------------- | ------------------------------ | ---------------------- |
| Buy base        | seller reserved base           | buyer available base   |
| Sell proceeds   | buyer reserved quote           | seller available quote |
| Buyer fee       | buyer reserved quote           | fee account quote      |
| Maker/taker fee | соответствующий reserved quote | fee account quote      |

Каждая строка выполняется через `settleReservedTransfer` и создаёт balanced ledger postings. `tradeId` является idempotency key settlement.

## Ошибки и retry

Insufficient balance отклоняет reserve до matching. Event-log timeout retry-ится ограниченное число раз; poison event после исчерпания retries попадает в DLQ. Duplicate `TradeExecuted` возвращает прежний `SettlementApplied` и не создаёт новые postings.

## Durable boundary

`SettlementService` зависит только от `LedgerPort`, `EventLogPort` и
`AtomicExecutionPort`. В production-like runtime `PostgresAtomicExecution`
объединяет posting matrix и `SettlementApplied` outbox row одним commit. Ошибка
append откатывает все ledger effects; локальный result cache обновляется только
после commit. SELL reserve base+fee также атомарен.

Decimal values `TradeExecuted` сериализуются строками и восстанавливаются перед
расчётом. Это исключает IEEE-754 и ошибку JSON serialization внутреннего
`bigint`. Poison payload не применяется к ledger и попадает в DLQ.

## Operational log events

`settlement.applied`, `settlement.retry` и `settlement.rejected` связываются по
trade/event IDs. Posting count допустим, но balances, fees, prices, quantity и
сами проводки исключены централизованной redaction policy.
