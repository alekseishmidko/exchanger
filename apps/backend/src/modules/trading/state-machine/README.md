# Trading state machine

State machine принимает admission только для своей instrument partition, поддерживает `ACTIVE/PAUSED`, deterministic clock и сериализуемые snapshots. Snapshot сохраняет sequence, lifecycle и idempotency results; после restart команда с прежним `commandId` не исполняется второй раз.

Transition handler не зависит от NestJS, БД, сети или системных часов. Persistence adapter и durable event log подключаются следующим этапом.

## Operational log events

State machine наблюдается на владеющей boundary sequencer через
`sequencer.command.applied`/`sequencer.command.rejected`. Внутри deterministic
transition logger не вызывается, чтобы replay оставался чистым и воспроизводимым.
