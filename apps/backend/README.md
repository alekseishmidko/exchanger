# Backend

NestJS-приложение биржи на TypeScript с Fastify adapter.

## Архитектурная модель

`apps/backend` является модульным монолитом. Все основные доменные компоненты на начальном этапе находятся в одном NestJS-приложении, но разделены явными модульными границами.

Структура модулей:

- `src/modules/gateway` — внешние REST/WebSocket-команды, auth и rate limits;
- `src/modules/trading` — торговый контур;
  - `sequencer` — последовательная обработка команд по инструменту;
  - `matching-engine` — order book и matching;
  - `settlement` — резервирование и расчёт сделок;
- `src/modules/ledger` — accounts, postings и балансы;
- `src/modules/market-data` — публичные рыночные события;
- `src/modules/projections` — read-модели истории и балансов;
- `src/modules/audit` — аудит и расследование операций;
- `src/modules/admin` — управление инструментами, лимитами и остановкой торгов;
- `src/modules/health` — техническая проверка доступности приложения.

Пустые доменные папки содержат `.gitkeep` и будут заполняться пошагово через TDD. Реализация модуля начинается с локального `README.md`, тестов и описания инвариантов.

Логические модули не должны обращаться к внутреннему состоянию друг друга напрямую. Для взаимодействия используются application-интерфейсы, типизированные команды и события. Решение и критерии возможного перехода к микросервисам описаны в [ADR 0001](../../docs/adr/0001-modular-monolith.md).

На начальном этапе не создаём отдельный микросервис для каждого компонента. Сначала проверяем доменную модель, инварианты и нагрузку в модульном монолите.

## Запуск

Из корня репозитория:

```bash
pnpm install
pnpm --filter @exchange/backend start:dev
```

Проверка:

```bash
curl http://localhost:5000/health
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
