# Market data и WebSocket protocol

Машиночитаемый контракт: [`asyncapi/market-data.yaml`](asyncapi/market-data.yaml).
Протокол версии `1.0` работает через Socket.IO namespace `/market-data` и только
WebSocket transport. Docker development endpoint — `http://localhost:5001`.

## Handshake и authentication

Public `book`, `trades`, `ticker` не требуют identity. Для private `user` клиент
передаёт API key в Socket.IO handshake `auth.apiKey` или заголовке `x-api-key`.
Ключ не входит ни в одно сообщение и не логируется. Невалидный переданный ключ
даёт `AUTH_INVALID_API_KEY` и server disconnect; отсутствие ключа разрешает
public channels, но private subscribe получает recoverable `AUTH_REQUIRED`.

Browser `Origin` должен входить в `WEBSOCKET_ALLOWED_ORIGINS`. Отсутствующий
Origin допускается для non-browser clients. В production wildcard не используется,
а TLS termination предоставляет `wss`.

```ts
const socket = io('http://localhost:5001/market-data', {
  transports: ['websocket'],
  auth: { apiKey: 'dev-key' },
});
```

## Envelope и ordering

Каждое server message имеет общий envelope:

```json
{
  "messageVersion": "1.0",
  "correlationId": "req-book-1",
  "emittedAt": "2026-09-09T00:00:00.000Z",
  "sequence": 42,
  "data": {}
}
```

`correlationId` равен `requestId` client command, создавшей subscription или
resync. У `market.data` envelope sequence совпадает с `data.sequence`. У
`market.ack`, `market.error`, `heartbeat.ack` sequence равна `0`: это control
messages, их нельзя применять к order book.

## Подписка и отписка

Public subscription:

```json
{ "requestId": "req-book-1", "channel": "book", "instrumentId": "BTC-USD" }
```

Private subscription:

```json
{ "requestId": "req-user-1", "channel": "user", "userId": "user-1" }
```

Команды отправляются как `market.subscribe`. Gateway сначала регистрирует
callback, затем отправляет `market.ack`, после чего initial book snapshot. Повтор
той же подписки заменяет старый callback без удвоения fan-out. Для удаления
клиент отправляет тот же routing payload как `market.unsubscribe`; удаление
несуществующей подписки идемпотентно подтверждается.

Private `userId` обязан совпадать с authenticated principal. Проверка выполняется
до регистрации callback, а private event публикуется только в registry данного
userId — общего public fan-out для него не существует.

## Channel catalog

| Data channel | Visibility | Содержимое и sequence |
| --- | --- | --- |
| `book` | public | полный snapshot на текущей instrument sequence |
| `book_update` | public | изменения уровней строго `N → N+1` |
| `trades` | public | price/quantity сделки строками |
| `ticker` | public | агрегированный price/quantity тик |
| `user` | private | плоский allow-listed user payload без ledger postings |

Для book level `quantity: "0"` означает удаление цены; другое значение полностью
заменяет агрегированное количество. Decimal values никогда не передаются JSON
number.

## Gap, reconnect и resync

Клиент хранит последнюю непрерывно применённую sequence отдельно для каждого
инструмента. Если приходит не `N+1`, клиент прекращает публикацию локального
стакана и отправляет:

```json
{
  "requestId": "req-resync-1",
  "instrumentId": "BTC-USD",
  "lastSequence": 41
}
```

Event: `market.resync`. Если bounded history содержит полный диапазон, сервер
отправляет ordered `book_update`; иначе один свежий `book` snapshot. Snapshot
атомарно заменяет локальный book. После transport disconnect клиент:

1. сохраняет last applied sequence;
2. создаёт новое соединение;
3. повторяет subscriptions;
4. отправляет resync;
5. показывает book только после непрерывного replay или snapshot replacement.

Reference hub хранит 1000 последних increments на instrument. Это не durable
event log; production replay window должен быть обеспечен отдельным adapter.

## Heartbeat, backpressure и disconnect

`heartbeat` принимает `requestId` и optional `sentAt`, а `heartbeat.ack`
возвращает `receivedAt`. Handler не зависит от БД, book или event log.

Fan-out ограничен `WEBSOCKET_MAX_SUBSCRIBERS`. Перед отправкой gateway проверяет
Socket.IO write buffer; при `WEBSOCKET_MAX_PENDING` отправляет
`MARKET_DATA_BACKPRESSURE` и отключает slow consumer. Client reconnect/resync
обязателен — сервер не накапливает неограниченную очередь.

Server disconnect выполняется после:

- `WEBSOCKET_ORIGIN_FORBIDDEN`;
- `AUTH_INVALID_API_KEY` при handshake;
- `MARKET_DATA_BACKPRESSURE`;
- `MARKET_DATA_CONTRACT_VIOLATION` от некорректного producer message.

Обычный network/client disconnect просто удаляет subscriptions. Recoverable
validation/authorization errors соединение не закрывают.

## Error catalog

| Code | Recoverable | Действие клиента |
| --- | --- | --- |
| `REQUEST_MALFORMED` | yes | исправить strict payload |
| `AUTH_REQUIRED` | yes | reconnect с API key для private stream |
| `PRIVATE_STREAM_FORBIDDEN` | yes | не запрашивать чужой userId |
| `MARKET_DATA_UNAVAILABLE` | yes | retry/resync с backoff |
| `MARKET_DATA_GAP` | yes | остановить book и выполнить resync |
| `MARKET_DATA_BACKPRESSURE` | no | reconnect и получить snapshot/replay |
| `AUTH_INVALID_API_KEY` | no | обновить credential перед reconnect |
| `WEBSOCKET_ORIGIN_FORBIDDEN` | no | использовать разрешённый deployment origin |
| `MARKET_DATA_CONTRACT_VIOLATION` | no | server incident; не применять payload |

Error envelope не содержит исходный payload, stack trace, API key или domain
exception.

## Versioning и compatibility

`messageVersion` меняется только при несовместимом wire change. В рамках `1.x`
разрешено добавлять optional fields и новые event types, которые старый клиент
может игнорировать. Нельзя менять смысл `sequence`, decimal string, существующее
имя channel/event или обязательное поле. Breaking change получает новый AsyncAPI
major version, отдельный namespace/период параллельной поддержки, migration guide
и compatibility fixtures. Удаление публикуется как deprecated минимум на один
релизный цикл.
