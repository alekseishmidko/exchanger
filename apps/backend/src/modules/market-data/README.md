# Market data и WebSocket boundary

`MarketDataHub` — transport-independent boundary для WebSocket adapter. Он не
создаёт WebSocket-соединения сам: Nest/Fastify adapter может преобразовать методы
подписки и callback в конкретный protocol (JSON WebSocket, SSE или internal bus).

Public book получает snapshot и ordered increments; `trades`/`ticker` используют
отдельные channel keys и не смешиваются с book updates. Все цены и количества
передаются decimal strings.

При gap клиент прекращает применять updates и вызывает `resync`. Hub возвращает
replay increments, если они ещё находятся в retention, иначе новый snapshot.
Snapshot заменяет локальную книгу атомарно; increments применяются только при
строгом переходе `N` в `N+1`.

Медленный consumer удаляется при превышении pending limit. Это backpressure
fail-closed поведение: клиент reconnect-ится и восстанавливает состояние через
snapshot, а сервер не накапливает неограниченную очередь.

Публичные методы, типы, ошибки и интерфейсы сопровождаются подробными русскими
JSDoc-комментариями с описанием алгоритма, границ ответственности и примерами
recovery.
