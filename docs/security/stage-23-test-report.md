# Этап 23: reproducible security test report

Дата выполнения: 2026-09-25. Платформа: macOS, Node.js 22, pnpm 10.15,
Docker Desktop, PostgreSQL 16, Redis server 8-compatible protocol.

## Проверенные инварианты

| Область | Команда | Результат |
|---|---|---|
| Full workspace | `corepack pnpm test` | contracts 11/11; backend 49 suites, 196 tests; frontend smoke |
| HTTP/WS contracts | `corepack pnpm --filter @exchange/backend contracts:check` | 9 suites, 38 tests; generated protected-route inventory требует 401 |
| Adversarial | `corepack pnpm adversarial:check` | contracts 11/11, backend 30/30 |
| Redis replicas | `RUN_REDIS_INTEGRATION=true corepack pnpm --filter @exchange/backend exec jest src/modules/identity/infrastructure/redis-session.int-spec.ts --runInBand` | 7/7: TTL, real restart, outage, revoke/touch, login/revoke-all generation, concurrent trim, shared limiter и raw-token canary |
| PostgreSQL replicas | `POSTGRES_URL=... corepack pnpm --filter @exchange/backend exec jest src/modules/gateway/infrastructure/postgres-api-key.registry.int-spec.ts src/modules/ledger/infrastructure/postgres.int-spec.ts --runInBand` | 2 suites, 15/15; live issue/rotate/revoke и durable transactions |
| PostgreSQL restart | `docker restart exchange-stage23-postgres`, затем `SELECT status,count(*) FROM machine_api_keys GROUP BY status` | `REVOKED|1`; plaintext secrets отсутствуют |
| Static gates | `corepack pnpm lint`, `corepack pnpm typecheck`, `corepack pnpm format:check`, `git diff --check` | passed |
| Dependency policy | `corepack pnpm security:audit:prod`, `corepack pnpm security:audit:all` | known vulnerabilities: 0 |
| Artifact | `corepack pnpm build`, `corepack pnpm security:artifact` | 185 compiled files; bypass/source maps/tests/credential patterns отсутствуют |
| Production image | `docker build --target production -t exchange-backend:stage23 .` | non-root `node`, 111,592,570 bytes, runtime workspace imports проходят; dev `jest`/`tsc` и compiled specs отсутствуют |
| Deploy policy | `POSTGRES_PASSWORD=... POSTGRES_APP_PASSWORD=... docker compose -f docker-compose.production.yml config --quiet`; `corepack pnpm security:check` | backend не имеет host `ports`; единственная внешняя точка — TLS ingress, `/health/*` и `/internal/*` закрыты |

Одноразовый PostgreSQL container после проверки удалён; persistent project
volumes и пользовательские данные не изменялись. Redis integration использует
временный каталог и удаляет его в `afterAll`.

## Revoke latency и отказ зависимостей

- HTTP API key authentication выполняет live SQL lookup: после commit revoke
  следующая проверка на любой replica отклоняется без cache window.
- Private WebSocket проверяет credential перед subscription и периодически;
  верхняя граница закрытия — `WEBSOCKET_AUTH_RECHECK_MS + 1s`.
- Human session touch — Lua CAS; revoke-all увеличивает generation под user lock.
- Redis/PostgreSQL outage даёт fail-closed admission; liveness не зависит от
  auth dependency, readiness сигнализирует degraded state.

## Повторение ingress bypass check

`scripts/check-repository.mjs` извлекает секцию `backend` production Compose и
падает при появлении host `ports`, отсутствии read-only/cap-drop/resources либо
неприкреплённом image. Caddy policy отвечает 404 на operational routes. Runtime
smoke выполняется deployment pipeline в целевой сети, поскольку production
contract намеренно требует внешние Redis TLS/ACL и recovery provider secrets.
