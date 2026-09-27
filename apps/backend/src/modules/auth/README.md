# Auth

`AuthModule` владеет всей authentication capability:

- регистрацией, password login, recovery и lifecycle пользовательских сессий;
- machine credentials и lifecycle API keys;
- DTO и runtime validation входных auth-команд;
- password hashing, cookies, CSRF, rate limits и authentication guards;
- authorization principal и policies, которые используют transport-модули.

`Gateway` не реализует auth и только использует публичные guards/principal из
`AuthModule`. `IdentityModule` является нижележащей persistence boundary для
пользовательских записей, challenges и session stores; в нём нет auth HTTP DTO,
контроллеров, validation или application use cases.

Human-auth contract test:
`pnpm --filter @exchange/backend test -- src/modules/auth/human-auth.e2e-spec.ts --runInBand`.
