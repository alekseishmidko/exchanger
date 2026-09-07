# Runbook: event log archive/retention/restore

Статус: accepted. Дата: 2026-09-08.

1. Создать `EventLogArchive` и проверить checksum до retention.
2. Сохранить архив в versioned object storage с encryption и object lock.
3. Проверить чтение архива из независимого процесса/credential.
4. Только после этого вызвать retention policy для live log.
5. При restore проверить format version, committed offset и checksum.
6. Replay-ить consumers идемпотентно, сверить projections и ledger.
7. При checksum mismatch изолировать архив и перейти к предыдущей валидной копии.

Целевой RPO для уже принятых событий — 0. RTO зависит от размера production log и
должен быть измерен вместе с broker/object storage, а не только in-memory тестом.
