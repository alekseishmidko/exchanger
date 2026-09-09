# REST и WebSocket client guide

## REST endpoint catalog и ownership

Все HTTP endpoints версионированы префиксом `/api/v1`. Полный реестр operations
находится в [`openapi/application.yaml`](openapi/application.yaml), детальный
Gateway command contract — в [`openapi/gateway.yaml`](openapi/gateway.yaml),
runtime Swagger — `/docs` в development.

| Группа | Endpoints | Доступ и ownership |
| --- | --- | --- |
| Health | `/health`, `/health/live`, `/health/ready` | public, без business data |
| Orders | `/api/v1/orders`, cancel | authenticated trader, только свой account; admin elevated |
| Instruments | `/api/v1/instruments` | authenticated read-only catalog |
| Accounts | `/api/v1/accounts/**` | владелец account; balance commands только admin |
| Projections | `/api/v1/projections/**` | фильтрация по principal userId |
| Admin | `/api/v1/admin/**` | role matrix и dual control |
| WebSocket public | book/trades/ticker | public subscription |
| WebSocket private | user | API key и exact userId match |
| Internal-only | matching, sequencer, settlement, postings | transport endpoint отсутствует |

## API key, idempotency и pagination

REST key передаётся только в `x-api-key`. Write requests дополнительно требуют
`Idempotency-Key` до 128 символов. Retry использует тот же ключ и тот же body;
другой body с прежним ключом получает `409`. Ключ scoped по API-key principal.

Cursor является opaque string. `limit` находится в диапазоне 1–100; клиент не
вычисляет cursor самостоятельно и использует `nextCursor` предыдущего ответа.

## Безопасные DTO examples

Gateway place/cancel:

```json
{ "commandId": "cmd-1", "orderId": "order-1", "accountId": "user-1", "instrumentId": "BTC-USD", "clientOrderId": "client-1", "side": "BUY", "orderType": "LIMIT", "quantity": "0.25", "limitPrice": "60000", "timeInForce": "GTC" }
```

```json
{ "commandId": "cancel-1", "orderId": "order-1", "accountId": "user-1", "instrumentId": "BTC-USD" }
```

Account create и balance command:

```json
{ "commandId": "account-cmd-1", "accountId": "account-1", "ownerId": "user-1", "balances": [{ "assetId": "USD", "code": "USD", "scale": 2 }] }
```

```json
{ "commandId": "balance-cmd-1", "action": "CREDIT", "amount": "100.25" }
```

Admin instrument/lifecycle:

```json
{ "commandId": "instrument-cmd-1", "mode": "CREATE", "instrumentId": "BTC-USD", "baseAssetId": "BTC", "quoteAssetId": "USD", "rules": { "version": "rules-v1", "effectiveAt": "2026-01-01T00:00:00.000Z", "tickSize": "0.5", "lotSize": "0.001", "minQuantity": "0.001", "maxQuantity": "10", "minPrice": "100", "maxPrice": "100000", "feePolicyVersion": "fees-v1", "maxOrderQuantity": "10", "maxOpenOrders": 100, "maxNotional": "1000000" } }
```

```json
{ "commandId": "status-cmd-1", "status": "ACTIVE" }
```

Admin freeze, circuit breaker, fee/risk policies:

```json
{ "commandId": "freeze-cmd-1", "targetType": "ACCOUNT", "targetId": "account-1", "action": "FREEZE" }
```

```json
{ "commandId": "stop-cmd-1", "targetId": "BTC-USD", "action": "STOP" }
```

```json
{ "commandId": "fee-cmd-1", "version": "fee-v2", "effectiveAt": "2026-02-01T00:00:00.000Z", "makerRate": "0.001", "takerRate": "0.002" }
```

```json
{ "commandId": "risk-cmd-1", "version": "risk-v2", "effectiveAt": "2026-02-01T00:00:00.000Z", "maxOrderNotional": "100000", "maxOpenOrders": 100 }
```

Response DTO examples и все поля доступны в Swagger schemas. Decimal money,
price, quantity и balance всегда строки. Неизвестные request fields запрещены.

## REST versioning и deprecation

Совместимые изменения `/api/v1` добавляют только optional response fields или
новые endpoints/error codes. Переименование, удаление, изменение типа или смысла
поля требует `/api/v2`, migration guide и периода параллельной поддержки.
Deprecated operation сначала получает OpenAPI `deprecated: true` и дату удаления;
удаление запрещено до истечения объявленного периода и прохождения compatibility
tests.

## WebSocket reconnect

Подробные events, envelopes, heartbeat, backpressure и resync описаны в
[`market-data.md`](market-data.md) и
[`asyncapi/market-data.yaml`](asyncapi/market-data.yaml). Клиент хранит sequence,
после reconnect повторяет subscriptions и запрашивает `market.resync`; private
subscription восстанавливается только после успешной повторной authentication.
