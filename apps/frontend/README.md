# Exchange Test Console

Тестовый React frontend для ручной проверки backend-функционала биржи.

## Локальный запуск

Backend:

```bash
pnpm dev
```

Frontend:

```bash
pnpm dev:frontend
```

Открой `http://localhost:5173`. В dev-режиме Vite проксирует `/api`, `/health` и
`/internal` на `http://localhost:5001`, поэтому отдельный CORS для тестового UI не
нужен.

Полный docker-compose development контур:

```bash
pnpm docker:development
```

После запуска:

- backend: `http://localhost:5001`;
- frontend: `http://localhost:5173`;
- Swagger: `http://localhost:5001/docs`.

## Что проверяется

- пошаговый User Flow: readiness → auth → instruments → account → place order
  → lookup → projection history → cancel → balances;
- health/readiness;
- authentication `auth/me`;
- place/cancel/list/lookup orders;
- instruments catalog;
- accounts и balances;
- projections и projection metrics;
- admin reconciliation, audit events, freeze/approval;
- latency последних ручных запросов через Recharts;
- таблицы ответов через TanStack Table.

## User Flow

Кнопка `Прогнать полный flow` выполняет сценарий через публичные HTTP endpoints и
показывает статус каждого шага на timeline. Это удобно для демонстрации бизнес
пути пользователя: где именно запрос принят, где появляется история, и на каком
boundary произошёл отказ.

Повторный запуск безопасен: account step допускает `409 account exists`, а
биржевые write-команды получают новый `Idempotency-Key` на каждый прогон.

## Производительность UI

По умолчанию консоль открывается в быстром режиме: отображаются flow, формы и
таблица заявок. Тяжёлые диагностические блоки — график latency, raw response,
request log и дополнительные таблицы — раскрываются кнопкой `Показать
диагностику`.

График Recharts загружается lazy chunk'ом только после включения диагностики, а
большие ответы вроде `/internal/metrics` сохраняются как bounded preview, чтобы
не подвешивать браузер.

## Безопасность

Панель предназначена для development/staging и не включается в production image.
API key хранится только в памяти текущей browser tab и передаётся в `x-api-key`;
после reload credential требуется ввести повторно. Журнал запросов не
сохраняется на сервере.
