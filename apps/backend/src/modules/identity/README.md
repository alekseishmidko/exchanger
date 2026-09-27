# Identity

`IdentityModule` — persistence boundary пользовательской identity. Он хранит
user records, password/challenge state и session records через PostgreSQL,
Redis либо component-test adapters и экспортирует только storage ports.

Регистрация, login, recovery, password hashing, session lifecycle, guards, DTO,
runtime validation и HTTP endpoints принадлежат [`AuthModule`](../auth/README.md).
`IdentityModule` не принимает transport-решений и не содержит auth use cases.

## Инварианты хранения

- PostgreSQL — source of truth users, password hashes и one-time challenge digest.
- Redis — source of truth active human sessions в production-like profile.
- Redis хранит HMAC identifiers вместо email, userId и raw session token.
- Memory adapters разрешены только в `component` profile.
