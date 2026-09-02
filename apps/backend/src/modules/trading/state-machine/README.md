# Trading state machine

State machine принимает admission только для своей instrument partition, поддерживает `ACTIVE/PAUSED`, deterministic clock и сериализуемые snapshots. Snapshot сохраняет sequence, lifecycle и idempotency results; после restart команда с прежним `commandId` не исполняется второй раз.

Transition handler не зависит от NestJS, БД, сети или системных часов. Persistence adapter и durable event log подключаются следующим этапом.
