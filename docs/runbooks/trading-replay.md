# Runbook: trading replay и восстановление sequencer

1. Остановить admission только затронутой instrument partition через owner control plane.
2. Проверить последний durable snapshot и его sequence.
3. Восстановить snapshot в state machine; snapshot с меньшим sequence, другой partition или повреждёнными idempotency results отклонить.
4. Replay-ить команды после snapshot по `instrumentId` в строгом порядке.
5. При обнаружении gap остановить partition и запросить missing command; не перескакивать sequence.
6. Сверить sequence, duplicate results и состояние downstream consumer-ов, затем выполнить resume.

После replay обязательно выполнить `docs/runbooks/reconciliation.md`. Измерять
RTO следует от начала recovery до разрешённого resume, RPO — как число durable
accepted command IDs, отсутствующих после replay. При RPO больше нуля resume
запрещён и инцидент эскалируется Trading Core и Ledger owners.

Во время восстановления должен быть ограничен queue depth (backpressure). Все операции recovery получают correlation ID; секреты и полные payloads в лог не записываются.
