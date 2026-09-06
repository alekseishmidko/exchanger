# Market data и WebSocket protocol

## Channel catalog

| Channel | Visibility | Payload |
| --- | --- | --- |
| `book` | public | полный order book snapshot |
| `book_update` | public | incremental price-level changes |
| `trades` | public | исполненные сделки |
| `ticker` | public | текущий ticker |
| `user` | private | события только authenticated user |

## Snapshot, increments и recovery

Сначала клиент подписывается на `book` и получает snapshot с `sequence=N`. Затем применяет только `book_update` с `N+1`, `N+2` и так далее. При разрыве или gap клиент прекращает применение increments и вызывает resync с последней применённой sequence. Если replay доступен, сервер возвращает ordered increments; если retention уже недостаточен — новый snapshot.

## Backpressure и fan-out

Reference hub ограничивает fan-out 1000 subscribers и 100 pending messages на consumer. Медленный consumer отключается с `MARKET_DATA_BACKPRESSURE`; клиент должен reconnect и запросить snapshot. Production использует bounded transport buffers, pub/sub fan-out и отдельные limits для public/private channels.

## Reconnection guide

1. Сохранить последнюю применённую sequence по instrument.
2. Переподключить WebSocket и повторить public/private subscriptions.
3. Запросить snapshot/replay с сохранённой sequence.
4. Проверить последовательность и атомарно заменить локальный book.
5. Не показывать пользователю book до завершения resync.

Private subscription никогда не принимает `userId`, не совпадающий с authenticated principal; private events не публикуются в public subscriber lists.

## Формат протокола

Подписка должна содержать `channel`, `instrumentId` для public market data и
`lastSequence` при reconnect. Сервер отвечает snapshot либо replay, затем
отправляет live messages. Клиент обязан хранить sequence отдельно для каждого
instrument/channel; sequence одного инструмента нельзя использовать для другого.

Пример восстановления:

```json
{ "action": "subscribe", "channel": "book", "instrumentId": "BTC-USD", "lastSequence": 412 }
```

Если доступен replay, сервер отвечает:

```json
{ "channel": "book_update", "instrumentId": "BTC-USD", "sequence": 413, "bids": [], "asks": [{ "price": "101", "quantity": "0" }] }
```

Если retention недостаточен, сервер отправляет новый `book` snapshot. Клиент не
должен отображать промежуточный локальный book до завершения этой замены.

## Consistency and retention

Snapshot и последующие increments образуют ordered stream. `quantity: "0"`
удаляет уровень, а положительное значение заменяет агрегированное количество.
Reference hub хранит последние 1000 increments на instrument; durable production
log должен хранить их не меньше максимального reconnect/replay window.

## Ошибки протокола

`MARKET_DATA_GAP` означает обязательный resync, `MARKET_DATA_BACKPRESSURE` —
отключение slow consumer с последующим reconnect. `PRIVATE_STREAM_FORBIDDEN`
означает отказ subscription без раскрытия существования чужого потока.
