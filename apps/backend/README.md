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

Интерактивная документация command API: `http://localhost:5000/docs`.
OpenAPI можно получить без UI по `/docs/openapi.json` или `/docs/openapi.yaml`.

При запуске через Docker Compose backend доступен на host-порту `5001`, при этом
внутри контейнера продолжает слушать `5000`:

```bash
pnpm docker:development
curl http://localhost:5001/health
```

В Docker development Swagger доступен по `http://localhost:5001/docs`.

Параметры `SWAGGER_ENABLED` и `SWAGGER_PATH` задаются в environment-файле.
Для production Swagger по умолчанию выключен; включать его следует только во
внутреннем защищённом контуре.

Другой свободный host-порт задаётся переменной `BACKEND_HOST_PORT`, например:

```bash
BACKEND_HOST_PORT=5010 pnpm docker:development
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

Системные проверки и состояние этапов описаны в
[development checklist](../../docs/development-checklist.md).
