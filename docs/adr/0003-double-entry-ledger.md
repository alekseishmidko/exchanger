# ADR 0003: Double-entry ledger для денежных операций

Статус: accepted  
Дата: 2026-08-31

## Контекст

Торговый контур должен сохранять проверяемую историю стоимости, поддерживать повторную доставку команд и исправлять ошибки без удаления аудита. Простая запись итогового баланса не позволяет доказать происхождение изменения и обнаружить расхождение между счетами.

## Решение

Ledger использует double-entry модель: каждая операция создаёт равные по активу debit и credit postings. Балансы являются проекцией postings для быстрого чтения, а `postings` — append-only source of audit truth. Повтор операции определяется `operationId` и возвращает ранее сохранённый результат. Исправление выполняется отдельной обратной операцией compensation.

PostgreSQL schema фиксирует non-negative balance constraints, foreign keys, `NUMERIC(78,18)`, уникальность IDs и idempotency record. In-memory aggregate используется для чистых доменных тестов и не заменяет транзакционный adapter.

## Рассмотренные альтернативы

- только mutable balance: отклонено из-за отсутствия аудита и reconciliation доказательства;
- single-entry journal: отклонено, потому что нельзя локально проверить сохранение стоимости;
- floating point: отклонено из-за недетерминированной точности денег.

## Последствия

Появляются дополнительные записи и необходимость атомарной транзакции при persistence, зато reconciliation может проверять `sum(DEBIT) = sum(CREDIT)`, а compensation не уничтожает историю.

## Тесты и критерии проверки

- unit и property-based tests проверяют Decimal, balance и posting invariants;
- concurrency test проверяет serializable reservation behavior aggregate;
- PostgreSQL integration test выполняет migration up, constraints и down;
- reconciliation проверяет балансировку каждой операции;
- duplicate/retry возвращает прежний `OperationResult`.
