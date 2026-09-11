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

API keys передаются только в заголовке и не попадают в response/logs. Registry
получает entries из `GATEWAY_API_KEYS` в формате
`key:role:userId,key2:admin:operator`. Внутри reference registry хранится SHA-256
digest, а не plaintext credential. Trader может обращаться только к своим
`accountId`; admin может выполнять object-level access.

Swagger содержит полный API-key lifecycle:

- `GET /api/v1/auth/me` — проверить текущие subject/role;
- `POST /api/v1/auth/api-keys` — выпустить ключ;
- `GET /api/v1/auth/api-keys` — получить metadata без secrets;
- `POST /api/v1/auth/api-keys/{keyId}/rotate` — заменить secret;
- `POST /api/v1/auth/api-keys/{keyId}/revoke` — отозвать ключ.

Issue/rotate возвращают secret только в command response. Lifecycle mutation
требует admin role, `Idempotency-Key` и создаёт tamper-evident audit event. В
development без дополнительной настройки доступны `dev-key` и
`dev-admin-key`; production default credentials отсутствуют и должны поступать
из secret storage.

## Error catalog and limits

Безопасные коды: `AUTH_INVALID_API_KEY`, `AUTH_OBJECT_FORBIDDEN`,
`AUTH_ADMIN_REQUIRED`, `API_KEY_NOT_FOUND`, `API_KEY_REVOKED`,
`API_KEY_SELF_MUTATION_FORBIDDEN`, `REQUEST_MALFORMED`, `ORDER_ID_MISMATCH`,
`IDEMPOTENCY_KEY_REQUIRED`, `IDEMPOTENCY_KEY_REUSED`, `RATE_LIMIT_EXCEEDED`.
`ORDER_ID_MISMATCH` означает, что `orderId` в URL и теле cancel-команды
различаются. Payload ограничен 16 KiB. Fixed window rate limit по API key: 60
command requests в минуту в reference implementation.

При timeout trading core клиент повторяет тот же request с тем же idempotency key. Повтор возвращает исходный результат; тот же key с другим payload получает `409`.

## Threat model

Основные угрозы: утечка API key, credential stuffing, oversized JSON, обход object authorization, replay команд и внутренние stack traces. Меры: secret-free logs/errors, hashed key registry, role/object checks, DTO allow-list, idempotency fingerprint, rotation/revocation, audit и rate limit. Production boundary дополнительно требует TLS, persistent credential/idempotency storage и distributed rate limiter.

## Operational log events

Все REST handlers автоматически получают `http.request.completed` либо
`http.request.rejected`. Place/cancel дополнительно создают ровно один
`gateway.command.accepted` или `gateway.command.rejected` внутри idempotency
callback. Поэтому сетевой retry не имитирует повторный business-success.

## Каталог REST boundaries

Runtime Swagger дополнительно содержит следующие группы:

- `Instruments` — каталог торговых пар и immutable rules history;
- `Accounts and balances` — создание аккаунта, owner-scoped чтение и admin-only
  balance commands;
- `Projections` — order/trade history, balance read models и lag metrics;
- `Admin` — instrument lifecycle/rules, freeze, circuit breaker, fee/risk policy,
  dual-control approval и reconciliation status.

Версия API является частью URL (`/api/v1`). Все request DTO проходят strict
runtime validation: неизвестное поле приводит к `REQUEST_MALFORMED`. Decimal
price, quantity, amount, available и reserved передаются только строками. Все
write endpoints требуют `Idempotency-Key`; identity и audit actor берутся из
API key, а не из пользовательского payload.
