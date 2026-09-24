# ADR 0011: Human identity и Redis sessions

Статус: accepted, 2026-09-24.

Решение: хранить users/adaptive password hashes в PostgreSQL, active human
sessions — в Redis, а machine API keys — в отдельной credential model. Cookie
содержит opaque random token; server storage использует HMAC lookup. Test bypass
является отдельным compile-time-visible, runtime-fail-closed механизмом.

Причины: stateless bearer JWT затрудняет немедленный point revoke и privilege
change; общий API-key/user store смешивает разные lifecycle и повышает риск
утечки. Redis даёт replica-consistent TTL/revoke, PostgreSQL — durable identity.

Последствия: Redis является critical readiness dependency; outage переводит auth
admission в fail-closed degraded mode. Deployment обязан обеспечить TLS, ACL,
namespace, secrets и восстановление topology. Memory adapters остаются только
для unit/component tests.
