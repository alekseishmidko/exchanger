# Ledger invariants

Статус: accepted  
Дата: 2026-08-31

## Баланс

Для каждой пары `(account, asset)` состояние представлено как:

```text
total = available + reserved
available >= 0
reserved >= 0
```

`reserve(amount)` уменьшает available и увеличивает reserved. `release(amount)` выполняет обратное действие. Ни одна операция не мутирует старый snapshot `Balance`.

## Double-entry

Для каждого asset в posting batch выполняется:

```text
sum(DEBIT) = sum(CREDIT)
```

Оригинальные postings не удаляются. Compensation создаёт новые проводки с противоположным направлением и тем же amount.

## Idempotency

`operationId` является ключом идемпотентности. Повтор операции возвращает сохранённый `OperationResult` и не изменяет balances или append-only postings.

## Decimal policy

Цены, количества и положительные суммы используют `Decimal`; balance deltas в transport contracts используют signed decimal strings. Арифметика выполняется через `bigint`, а округление half-up явно принимает количество знаков после запятой.
