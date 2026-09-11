# Market data и WebSocket boundary

## Назначение и границы

`MarketDataHub` хранит transport-independent snapshots, bounded replay history и
subscriber callbacks. `MarketDataGateway` — настоящий NestJS Socket.IO adapter:
он валидирует client commands, аутентифицирует private stream и преобразует
публичные сообщения hub в versioned wire envelopes.

Gateway не сериализует matching-engine order book или ledger entities. Перед
отправкой каждое `MarketDataMessage` повторно проходит strict runtime schema;
private payload допускает только плоские JSON scalars, поэтому массив проводок
или вложенный aggregate не может случайно попасть клиенту.

## Подключение

Development endpoint: `ws://localhost:5001/market-data`, Socket.IO path:
`/socket.io`, transport: только `websocket`.

```ts
const socket = io('http://localhost:5001/market-data', {
  transports: ['websocket'],
  auth: { apiKey: 'development-key' }, // требуется только private stream
});
```

Допустимые browser origins задаются `WEBSOCKET_ALLOWED_ORIGINS`. Лимиты
`WEBSOCKET_MAX_SUBSCRIBERS` и `WEBSOCKET_MAX_PENDING` создают bounded fan-out и
write buffer. При disconnect gateway вызывает все unsubscribe callbacks и
удаляет socket из registry.

## Client/server events

| Event                | Направление     | Назначение                                              |
| -------------------- | --------------- | ------------------------------------------------------- |
| `market.subscribe`   | client → server | public book/trades/ticker или private user subscription |
| `market.unsubscribe` | client → server | идемпотентное удаление подписки                         |
| `market.resync`      | client → server | replay/snapshot после gap или reconnect                 |
| `heartbeat`          | client → server | проверка живости transport                              |
| `market.ack`         | server → client | подтверждение subscribe/unsubscribe                     |
| `market.data`        | server → client | snapshot, increment, trade, ticker, private event       |
| `market.error`       | server → client | безопасная protocol error                               |
| `heartbeat.ack`      | server → client | heartbeat response                                      |

Все server events имеют envelope `1.0` с `correlationId`, `emittedAt` и
`sequence`. Для data sequence совпадает с payload sequence; control messages
используют `0` и не участвуют в ordering.

## Контракты и тестирование

Версионируемый контракт находится в
[`docs/asyncapi/market-data.yaml`](../../../../../docs/asyncapi/market-data.yaml),
подробный клиентский протокол — в
[`docs/market-data.md`](../../../../../docs/market-data.md). `pnpm contracts:check`
валидирует AsyncAPI/OpenAPI, проверяет drift HTTP routes и запускает реальные
Socket.IO integration tests.

Публичные типы, validation schemas, gateway handlers и application methods имеют
русские JSDoc с алгоритмом, ограничениями и примерами.

## Operational log events

`websocket.connected` и `websocket.subscribed` отмечают transport boundaries;
`websocket.rejected` содержит protocol code и correlation ID. Каждое fan-out
сообщение не логируется, чтобы slow consumer или burst не создавали log storm.
