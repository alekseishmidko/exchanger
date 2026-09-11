# Gateway

Gateway выполняет API-key authentication, object authorization, strict DTO
validation, rate limit и idempotent mapping HTTP-команд в trading port. Transport
не получает прямого доступа к matching engine или ledger aggregate.

## Operational log events

`gateway.command.accepted` пишется внутри idempotency callback после успешного
вызова application port; `gateway.command.rejected` — при отказе port. Все auth,
validation и pagination запросы дополнительно покрыты глобальными
`http.request.completed`/`http.request.rejected`. Headers, API keys и DTO payload
в metadata не передаются. Полный контракт: [docs/gateway.md](../../../../../docs/gateway.md).
