# Runbook: PostgreSQL backup/restore verification

Статус: ready for human execution. Дата: 2026-09-08.

Требуются отдельные source и disposable restore databases, а также `pg_dump`,
`pg_restore`, `psql`. Target database будет очищена — production URL использовать
запрещено.

```bash
POSTGRES_URL='postgres://source...' \
POSTGRES_RESTORE_URL='postgres://disposable-restore...' \
ALLOW_POSTGRES_RESTORE=YES \
pnpm postgres:backup-restore
```

После успешного restore:

1. сравнить количество accounts, balances, postings и idempotency records;
2. выполнить ledger/event reconciliation;
3. зафиксировать размер backup, start/end time, фактические RTO и RPO;
4. проверить отсутствие restore target в application service discovery;
5. удалить disposable database по правилам инфраструктуры;
6. записать исполнителя и результат в runbook verification log.
