# Gateway и command API

## OpenAPI contract

Base path: `/api/v1`. Машинный контракт опубликован в [gateway.yaml](openapi/gateway.yaml). Все command endpoints требуют `x-api-key` и уникальный `Idempotency-Key`.

`POST /orders` принимает typed decimal strings, `LIMIT` требует `limitPrice`, `MARKET` запрещает его. `POST /orders/{orderId}/cancel` отменяет заявку после проверки владельца объекта. Ответ содержит только `commandId`, `orderId` и безопасный status.

Пример:

```http
POST /api/v1/orders
x-api-key: dev-key
Idempotency-Key: client-request-123
Content-Type: application/json
```

```json
{
  "commandId": "cmd-1",
  "orderId": "order-1",
  "accountId": "dev-user",
  "instrumentId": "BTC-USD",
  "clientOrderId": "client-1",
  "side": "BUY",
  "orderType": "LIMIT",
  "quantity": "1.25",
  "limitPrice": "100",
  "timeInForce": "GTC"
}
```

## Auth, roles and API keys

API keys передаются только в заголовке и не попадают в response/logs. Registry получает entries из `GATEWAY_API_KEYS` в формате `key:role:userId,key2:admin:operator`. Trader может обращаться только к своим `accountId`; admin может выполнять object-level access. В production ключи передаются через secret storage, а не через Git.

## Error catalog and limits

Безопасные коды: `AUTH_INVALID_API_KEY`, `AUTH_OBJECT_FORBIDDEN`, `REQUEST_MALFORMED`, `IDEMPOTENCY_KEY_REQUIRED`, `IDEMPOTENCY_KEY_REUSED`, `RATE_LIMIT_EXCEEDED`. Payload ограничен 16 KiB. Fixed window rate limit по API key: 60 command requests в минуту в reference implementation.

При timeout trading core клиент повторяет тот же request с тем же idempotency key. Повтор возвращает исходный результат; тот же key с другим payload получает `409`.

## Threat model

Основные угрозы: утечка API key, credential stuffing, oversized JSON, обход object authorization, replay команд и внутренние stack traces. Меры: secret-free logs/errors, bounded body, key registry, role/object checks, DTO allow-list, idempotency fingerprint и rate limit. Production boundary дополнительно требует TLS, key rotation, persistent idempotency store и distributed rate limiter.
