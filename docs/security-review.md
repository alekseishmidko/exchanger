# Security review и threat model update

Статус: accepted for Pilot, production gaps recorded. Дата: 2026-09-08.

## Активы и trust boundaries

Защищаются API keys, account balances, private order/trade events, administrative
identity, audit chain и event-log archives. Внешние boundaries: REST Gateway,
WebSocket transport, PostgreSQL, event broker/object storage и admin identity
provider.

## Проверенные угрозы

- malformed/oversized payload блокируется до command mapping;
- чужой account/private stream блокируется object authorization;
- retry/replay не создаёт повторный settlement;
- rate/fan-out limits ограничивают resource exhaustion;
- error responses и structured logs не содержат ключи и секреты;
- critical admin action требует двух независимых actors;
- изменение audit/event archive обнаруживается hash/checksum;
- compensation сохраняет исходную финансовую и административную запись.

## Production gaps

- in-memory idempotency, projections, audit и event log необходимо заменить
  durable shared stores;
- API keys должны храниться в виде хешей с rotation/revocation;
- WebSocket transport имеет origin allow-list, heartbeat и bounded buffer; для
  production всё ещё требуются TLS termination и инфраструктурный idle timeout;
- audit archive требует WORM/object lock;
- distributed rate limiting и per-tenant quotas пока не подключены;
- PostgreSQL backup/restore и infrastructure RTO/RPO ещё не подтверждены.

Эти gaps запрещают считать текущий Pilot production-ready, но не нарушают
детерминированность domain/reference тестов.
