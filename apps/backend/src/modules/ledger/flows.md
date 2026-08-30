# Ledger flows

## Reserve

```mermaid
sequenceDiagram
  participant C as Command handler
  participant L as Ledger
  participant B as Balance
  participant J as Posting journal
  C->>L: reserve(operationId, account, asset, amount)
  L->>B: available -= amount; reserved += amount
  L->>J: DEBIT account / CREDIT system
  L-->>C: OperationResult
```

Недостаточный available или повторный `operationId` останавливает новый эффект; исходная запись не изменяется.

## Release

`release` выполняет обратный переход `reserved → available` и записывает обратную double-entry пару. Повторная операция возвращает сохранённый результат.

## Transfer и compensation

`transfer` атомарно проверяет debit и credit snapshots, затем записывает одну сбалансированную пару. `compensate` создаёт новые проводки с противоположным направлением и не удаляет исходную пару, поэтому audit trail остаётся полным.
