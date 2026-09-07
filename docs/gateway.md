# Gateway и command API

## OpenAPI contract

Base path: `/api/v1`. Машинный контракт опубликован в [gateway.yaml](openapi/gateway.yaml). Все command endpoints требуют `x-api-key` и уникальный `Idempotency-Key`.

При локальном запуске NestJS также генерирует актуальный контракт из controller
и DTO metadata. Swagger UI доступен по `/docs`, JSON — по
`/docs/openapi.json`, YAML — по `/docs/openapi.yaml`. Статический
`docs/openapi/gateway.yaml` остаётся версионируемым клиентским контрактом, а
runtime-документ позволяет проверить фактически запущенную сборку. Расхождение
между ними считается дефектом контракта.

Путь задаётся `SWAGGER_PATH` без начального `/`. `SWAGGER_ENABLED=true|false`
явно управляет публикацией; если флаг не указан, документация включается только
в development. Авторизация, введённая в Swagger UI, не сохраняется после
перезагрузки страницы (`persistAuthorization=false`), чтобы API-ключ не оставался
в browser storage.

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

Безопасные коды: `AUTH_INVALID_API_KEY`, `AUTH_OBJECT_FORBIDDEN`, `REQUEST_MALFORMED`, `ORDER_ID_MISMATCH`, `IDEMPOTENCY_KEY_REQUIRED`, `IDEMPOTENCY_KEY_REUSED`, `RATE_LIMIT_EXCEEDED`. `ORDER_ID_MISMATCH` означает, что `orderId` в URL и теле cancel-команды различаются. Payload ограничен 16 KiB. Fixed window rate limit по API key: 60 command requests в минуту в reference implementation.

При timeout trading core клиент повторяет тот же request с тем же idempotency key. Повтор возвращает исходный результат; тот же key с другим payload получает `409`.

## Threat model

Основные угрозы: утечка API key, credential stuffing, oversized JSON, обход object authorization, replay команд и внутренние stack traces. Меры: secret-free logs/errors, bounded body, key registry, role/object checks, DTO allow-list, idempotency fingerprint и rate limit. Production boundary дополнительно требует TLS, key rotation, persistent idempotency store и distributed rate limiter.
