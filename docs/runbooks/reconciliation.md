# Runbook: reconciliation после отказа

1. Оставить затронутый instrument/account в paused состоянии и сохранить
   artifacts fault timeline. Не очищать event log, DLQ или audit records.
2. Получить `/api/v1/admin/reconciliation` с отдельным auditor/admin identity.
   `auditIntegrity=false` является stop condition, а не предупреждением.
3. Сверить множество accepted command IDs с durable event envelopes; для каждого
   TradeExecuted должен существовать ровно один SettlementApplied business effect.
4. Запустить ledger reconciliation: debit и credit по operation/asset равны,
   available не отрицателен, reserved не превышает total, duplicate operation ID
   не добавляет posting.
5. Сравнить consumer offsets и projection sequence с концом event log. Gap
   устранять упорядоченным replay; poison event переносить в DLQ с incident link.
6. Повторить read-model rebuild и сравнить его с live projection. Расхождение
   запрещает resume даже при зелёном HTTP health.
7. Зафиксировать фактические RTO/RPO, потерянные/повторные эффекты (ожидается 0),
   остаточный backlog и время его схождения.
8. Resume разрешает Incident Commander после подтверждения Ledger и Trading
   owners. Любая коррекция выполняется новой компенсирующей операцией.
