# Projections и query API

## Observability boundary

`projection.apply` продолжает trace исходного event, projection lag публикуется
bounded gauge, а sequence gap — отдельным counter. User/account IDs не являются
labels и применяются только внутри authorization-filtered read model.

Projection store строит order history, trade history и balance read models из упорядоченного event log. `eventId` защищает от duplicate delivery, `sequence` обнаруживает gap, а `rebuild(events)` очищает состояние и выполняет полный replay.

Query endpoints:

- `GET /api/v1/projections/orders?limit=50&cursor=...`;
- `GET /api/v1/projections/trades?limit=50&cursor=...`;
- `GET /api/v1/projections/balances?limit=50&cursor=...`;
- `GET /api/v1/projections/metrics`.

Все endpoints используют Gateway API key и фильтруют данные по `principal.userId` до cursor pagination. Запрос не может указать чужой user/account ID.

Все публичные интерфейсы и методы имеют подробные русские JSDoc-комментарии.

Каждый endpoint описан отдельным Swagger response DTO. Query parameters
`limit/cursor`, ошибки pagination, API-key security и decimal-string поля входят
в generated OpenAPI. DTO содержат только read-model snapshots и не экспортируют
`ProjectionStore` либо внутренние event payload.

Версионируемый реестр routes и клиентские правила: [OpenAPI](../../../../../docs/openapi/application.yaml)
и [client guide](../../../../../docs/api-client-guide.md).

## Operational log events

`projection.applied`, `projection.duplicate`, `projection.rebuilt` и
`projection.gap` описывают consumer state. Duplicate имеет outcome `recovered` и
не считается вторым business-success. Event payload/read model не сериализуются.
