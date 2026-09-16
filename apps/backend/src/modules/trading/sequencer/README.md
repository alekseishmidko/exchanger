# Trading sequencer

## Production ownership

`PostgresSequencerStore` хранит instrument lease с fencing epoch. Transfer
увеличивает epoch и закрывает admission до snapshot restore и ordered replay.
Sequence резервируется в той же transaction, что command journal и outbox;
rollback команды откатывает sequence.

Snapshot включает version, instrument ID, last sequence, boundary event offset,
fencing epoch, payload и SHA-256 checksum. Snapshot запрещён при in-flight
commands. Graceful shutdown переводит partition в `DRAINING`, проверяет drain и
освобождает lease. Полный алгоритм описан в
[`docs/durable-runtime.md`](../../../../../docs/durable-runtime.md).

## Observability boundary

`trading.sequencer.wait` измеряет ordering latency, а gap увеличивает
`exchange_sequence_gaps_total{component="sequencer"}`. Instrument ID не является
metric label, поэтому число partitions не создаёт unbounded series.

Sequencer владеет routing команд по `instrumentId` и проверяет, что команду отправляет единственный partition owner. Каждая instrument partition имеет независимый monotonic sequence.

Команда с gap, неверным owner или отсутствующей partition отклоняется до state transition. Повторный `commandId` возвращает сохранённый результат без повторного вызова transition.

## Operational log events

`sequencer.command.applied` содержит command ID, instrument и sequence;
`sequencer.command.rejected` — стабильный admission/ownership code. Payload
команды и результат transition не логируются.
