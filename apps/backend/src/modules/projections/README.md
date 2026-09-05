# Projections и query API

Projection store строит order history, trade history и balance read models из упорядоченного event log. `eventId` защищает от duplicate delivery, `sequence` обнаруживает gap, а `rebuild(events)` очищает состояние и выполняет полный replay.

Query endpoints:

- `GET /api/v1/projections/orders?limit=50&cursor=...`;
- `GET /api/v1/projections/trades?limit=50&cursor=...`;
- `GET /api/v1/projections/balances?limit=50&cursor=...`;
- `GET /api/v1/projections/metrics`.

Все endpoints используют Gateway API key и фильтруют данные по `principal.userId` до cursor pagination. Запрос не может указать чужой user/account ID.

Все публичные интерфейсы и методы имеют подробные русские JSDoc-комментарии.
