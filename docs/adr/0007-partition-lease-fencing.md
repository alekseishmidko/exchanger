# ADR-0007: lease и fencing для instrument partitions

- Статус: принято
- Дата: 2026-09-17
- Владельцы: Trading Platform

## Контекст

Matching engine требует ровно одного writer для каждого `instrumentId`. Обычный
distributed lock не защищает от остановившегося процесса: после timeout старый
owner может продолжить callback и записать результат одновременно с новым.
Нужен долговечный ownership protocol, который переживает restart, запрещает
stale writes и не открывает admission до восстановления последовательности.

Рассматривались session-level PostgreSQL advisory locks, broker consumer-group
ownership и lease с fencing token. Session lock освобождается при разрыве
соединения, но не даёт durable epoch для проверки уже запущенных callbacks.
Consumer group станет уместен после появления отдельного broker transport, но
не должен быть единственной защитой PostgreSQL command state.

## Решение

Для каждого инструмента PostgreSQL хранит lease с `owner_id`, `lease_until` и
монотонным `fencing_epoch`. Долговечный epoch также хранится в
`sequencer_partitions`, поэтому удаление lease при graceful shutdown не сбрасывает
историю fencing. Продлить активный lease может только тот же owner с тем же epoch.
Любой takeover после expiry или release получает больший epoch.

Каждая mutation sequence или snapshot выполняется в транзакции, блокирует lease
row и сверяет instrument, owner, epoch и deadline. Следовательно, stale process
не может записать данные после передачи partition, даже если его callback
возобновился после долгой паузы.

## Recovery protocol

1. Новый owner получает lease и переводит существующую partition в
   `RECOVERING`; command admission закрывается.
2. Adapter выбирает последний snapshot, проверяет supported version и SHA-256
   checksum канонического payload.
3. Commands после snapshot читаются из journal строго по sequence. Первый gap,
   неизвестная версия или несовпадение replay tail с durable high watermark
   останавливают recovery.
4. State machine применяет snapshot и ordered commands. Только после достижения
   high watermark вызывается `completeRecovery`, переводящий partition в
   `READY` и открывающий admission.
5. Snapshot создаётся только при отсутствии `ACCEPTED`, `PROCESSING` и
   `RECOVERY` commands. Он содержит version, instrument, last sequence,
   outbox boundary offset, fencing epoch, payload и checksum.

Storage adapter формирует и проверяет recovery plan, но фактическое применение
payload к matching-engine state остаётся обязанностью orchestration layer.
Поэтому process-level restart и rolling-replica gate не считаются закрытыми до
соответствующих SIGKILL/двухрепличных тестов.

## Graceful и аварийная остановка

Graceful shutdown сначала закрывает admission и переводит partition в
`DRAINING`. Lease удаляется только при отсутствии in-flight durable commands.
Если drain не завершён, shutdown возвращает ошибку, а lease остаётся до expiry,
чтобы новый owner обязательно прошёл recovery.

При аварийной остановке lease не изменяется. После bounded TTL новый process
получает следующий epoch и выполняет тот же recovery protocol. TTL задаёт нижнюю
границу failover RTO; уменьшать его без учёта transaction latency нельзя.

## Инварианты и последствия

- одновременно писать может только holder актуального epoch;
- sequence резервируется в той же транзакции, что command journal и outbox;
- rollback command append откатывает sequence и не создаёт gap;
- snapshot ускоряет recovery, но command journal остаётся source of truth;
- clock решения принимает PostgreSQL deadline, а business ordering определяется
  sequence, не wall-clock временем;
- hot instrument остаётся последовательным bottleneck по проекту; масштабирование
  достигается распределением независимых instruments между owners.

Цена решения — дополнительная блокировка lease/partition rows на command path и
необходимость bounded query timeout. Lease store является critical readiness
dependency; observability outage не влияет на ownership и admission.

## Проверка

PostgreSQL integration suite проверяет takeover после expiry, рост epoch,
отклонение stale token, checksum/version, contiguous replay до high watermark,
rollback sequence и reacquire после graceful release. Отдельный production-like
этап должен проверить две backend replicas, starvation, rolling restart и
process kill под продолжающейся нагрузкой.
