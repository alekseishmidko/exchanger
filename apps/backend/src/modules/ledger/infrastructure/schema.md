# Ledger persistence schema

PostgreSQL является source of truth для assets, accounts, balances, append-only postings и idempotency records. Денежные значения хранятся в `NUMERIC(78,18)`, а не в floating point. Баланс защищён `CHECK` constraints, составным ключом `(account_id, asset_id)` и foreign keys.

`postings` не обновляется и не удаляется обычными операциями. Исправление выполняется только дополнительной compensation-проводкой. `idempotency_records` связывает operation ID с результатом и позволяет безопасно повторить запрос после timeout.

Audit postings хранятся минимум весь срок жизни финансовой истории; retention и archive policy задаются эксплуатационной политикой, а физическое удаление запрещено до завершения legal/audit retention window. Migration down используется только для локальных тестов и не является production data deletion procedure.
