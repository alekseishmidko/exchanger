# Backend

NestJS-приложение биржи на TypeScript с Fastify adapter.

## Запуск

Из корня репозитория:

```bash
pnpm install
pnpm --filter @exchange/backend start:dev
```

Проверка:

```bash
curl http://localhost:3000/health
```

## Проверки

```bash
pnpm --filter @exchange/backend test
pnpm --filter @exchange/backend typecheck
pnpm --filter @exchange/backend build
```

## Структура

- `src/modules/` — вертикальные прикладные модули;
- `src/main.ts` — composition root и запуск приложения;
- `jest.config.ts` — конфигурация тестов;
- локальная документация модуля хранится рядом с ним.

Следующий доменный модуль — `matching-engine`. Он будет добавляться через тесты инвариантов order book, а не через NestJS controller.
