# Этап 23: findings и ответственность

Дата triage: 2026-09-24. Дата следующего review: 2026-12-25.

| Finding | Severity | Owner | Срок | Статус | Regression evidence |
|---|---|---|---|---|---|
| Межрепличный stale API key | high | Backend/Auth | 2026-09-30 | closed 2026-09-25 | PostgreSQL registry unit+integration, two replicas |
| Redis revoke/touch resurrection | high | Backend/Auth | 2026-09-30 | closed 2026-09-25 | `redis-session.int-spec.ts` stale touch race |
| Cookie/bearer CSRF confusion | high | Backend/API | 2026-09-30 | closed 2026-09-25 | startup rejects unsupported transport; cookie/CSRF tests |
| Process-local brute-force limit | high | Platform/Auth | 2026-10-03 | closed 2026-09-25 | shared Redis replica integration |
| Неполная scope matrix | high | Backend/API | 2026-10-03 | closed 2026-09-25 | generated route inventory and negative contracts |
| Public backend/metrics и root image | high | Platform | 2026-10-03 | closed 2026-09-25 | Compose policy, Caddy deny, image inspection |
| Recovery token/timing lifecycle | medium | Backend/Auth | 2026-10-07 | closed 2026-09-25 | identity timing/replay/supersession tests |
| Vulnerable Fastify/qs graph | medium | Platform | 2026-09-25 | closed 2026-09-25 | production/full `pnpm audit` gates |
| Browser Web Storage API keys | medium | Frontend | 2026-09-25 | closed 2026-09-25 | repository security check |
| Недостаточный security CI | medium | Platform/Security | 2026-10-07 | closed 2026-09-25 | audit, Gitleaks, Semgrep, Trivy, provenance/SBOM jobs |

## Accepted risk

Registration сохраняет HTTP 409 при существующем email ради действующего API
contract. Response не содержит email/identity и использует generic code; shared
IP/account/global limiter ограничивает эксплуатацию oracle. Owner: Product
Security. Пересмотр не позднее 2026-12-25; изменение public semantics требует ADR.

Плановая rotation `AUTH_TOKEN_HASH_SECRET` пока требует controlled global logout,
так как secret защищает Redis key namespace. Это безопасный fail-closed вариант,
а не silent dual-key fallback. Owner: Backend/Auth; отдельная migration обязательна
до требования zero-logout rotation.
