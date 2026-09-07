# Runbook: administrative/audit incident

Статус: accepted. Дата: 2026-09-07.

1. При `auditIntegrity=false` немедленно остановить administrative writes.
2. Зафиксировать последнюю валидную sequence/hash и изолировать audit storage.
3. Сопоставить admin commands, event log, ledger postings и identity provider logs.
4. Не исправлять записи на месте; восстановить append-only chain из WORM backup.
5. Неверные бизнес-эффекты обратить compensation command или новой policy version.
6. Провести dual-control review, rotation credentials и повторную reconciliation.
7. Документировать cause, impact, recovery point и меры предотвращения.
