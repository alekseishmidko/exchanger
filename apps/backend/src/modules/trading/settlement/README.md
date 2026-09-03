# Settlement module

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

## Границы

Текущая реализация содержит in-memory reference adapter. Durable persistence, transaction boundary и external broker adapter подключаются через event-log/ledger ports без изменения settlement policy.
