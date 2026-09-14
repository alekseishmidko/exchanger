# Runbook: отказ критичной зависимости

## Диагностика

1. Найти первый failed span/log event по `correlationId`, затем проверить
   readiness и dependency-specific alert. Liveness подтверждает только жизнь
   процесса и не разрешает admission.
2. Определить класс: timeout/reset, saturation/pool exhaustion, read-only,
   deadlock/lock contention, disk pressure либо invalid credentials/DNS.
3. Зафиксировать последний durable accepted command, event offset, partition
   sequence и projection high watermark. Эти значения образуют baseline RPO.
4. Если dependency критична для durable acceptance, остановить admission через
   circuit breaker. Не возвращать клиенту success до durable boundary.

## Восстановление

1. Устранить fault или переключить на заранее проверенный replica/adapter.
2. Дождаться успешной dependency probe; observability backend не включать в
   business readiness.
3. Replay выполнять с последнего подтверждённого offset/snapshot. Gap не
   перескакивать, poison event изолировать по DLQ policy.
4. Запустить reconciliation, сравнить command IDs, event IDs, ledger postings,
   audit chain и projection lag.
5. Возобновлять admission постепенно; подтвердить, что backlog монотонно
   уменьшается и p95/p99 возвращаются в budget.

## Эскалация

Ledger/PostgreSQL — Ledger Platform; event log/consumer — Trading Platform;
partition/sequence — Trading Core. При RPO больше нуля, audit tampering или
финансовом расхождении немедленно подключить Incident Commander и Security.
Исходные проводки/события не редактировать: исправление только replay или
компенсирующей immutable записью.
