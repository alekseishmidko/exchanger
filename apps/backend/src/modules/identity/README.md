# Identity

Модуль отделяет три несовместимых механизма: human sessions, machine API keys и
test-only bypass. Он отвечает за users/password/recovery, Redis session state,
self-service и административный session control. Торговые object policies и
email rendering ему не принадлежат.

## Инварианты

- PostgreSQL — source of truth users, password hashes и one-time challenge digest.
- Redis — единственный source of truth active human sessions в production-like profile.
- Клиент хранит opaque random token; Redis получает только HMAC digest. Redis keys
  используют HMAC identifiers и не содержат email/userId/token открытым текстом.
- Password хранится как `scrypt(N,r,p,salt,digest)` с per-password salt и отдельным pepper.
- `securityVersion` делает все старые sessions stale после password/privilege change.
- Public DTO собираются allow-list mapping и не содержат roles, hashes, token,
  Redis keys и security flags.
- Memory stores разрешены только в `component`; validation блокирует иной startup.

Тест: `pnpm --filter @exchange/backend test -- src/modules/identity/identity.spec.ts --runInBand`.
