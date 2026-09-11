# Runbook: поиск критичного потока в structured logs

1. Возьмите `x-correlation-id` из HTTP response либо `correlationId` WebSocket
   envelope. Никогда не используйте для поиска API key или Authorization header.
2. Найдите начальный `http.request.*`/`websocket.*` event по точному
   `correlationId` и проверьте `outcome`, status code и `durationMs`.
3. В том же потоке найдите `gateway.command.*`, затем сохраните `commandId`.
   Duplicate HTTP retry может не иметь второго business-success — это ожидаемо.
4. Перейдите к `event-log.appended` по `correlationId`/`causationId=commandId` и
   сохраните `eventId`. Проверьте timeout/retry/DLQ события этого event ID.
5. По `eventId` найдите consumer boundary: `settlement.*` или `projection.*`.
   Следующий event должен ссылаться на исходный через `causationId`.
6. Для settlement сопоставьте `tradeId` из allow-listed metadata с
   reconciliation; финансовый payload и postings в logs искать запрещено.
7. Если цепочка оборвалась, проверьте `health.dependency.failed`,
   `event-log.timeout`, `projection.gap` и consumer lag за тот же интервал.
8. При `audit.integrity.failed` прекратите административные изменения, сохраните
   временной диапазон и запустите incident runbook. Operational logs не заменяют
   исходную immutable audit chain.

Примеры фильтров для JSON-aware collector:

```text
service="exchange-backend" AND correlationId="corr-123"
service="exchange-backend" AND commandId="command-123"
service="exchange-backend" AND eventId="event-123"
```

Перед передачей фрагмента третьей стороне повторно проверьте отсутствие полей со
значением, отличным от `[REDACTED]`, для credentials, identities и financial data.
