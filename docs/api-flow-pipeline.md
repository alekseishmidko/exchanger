# Black-box API flow pipeline

Pipeline проверяет фактически запущенное development-приложение через публичный
HTTP transport. Он не импортирует Nest modules и поэтому обнаруживает ошибки
Docker port mapping, startup configuration, guards, DTO validation и routing,
которые не видны при прямом unit-вызове application service.

## Локальный запуск

Поднять Compose и выполнить все проверки одной командой:

```bash
pnpm api:flows:development
```

Если development-контейнер уже запущен:

```bash
pnpm api:flows
```

По умолчанию используются `http://localhost:5001` и development API key
`dev-key`. Для другого окружения значения передаются явно:

```bash
API_FLOW_BASE_URL=https://dev.exchange.example.com \
API_FLOW_API_KEY="$EXCHANGE_SMOKE_API_KEY" \
pnpm api:flows
```

API key не печатается и не сохраняется. Для удалённого CI-окружения его следует
хранить в GitHub Actions secret.

## Группы и порядок

1. `health`: liveness и readiness;
2. `documentation`: OpenAPI и обязательный auth route;
3. `authentication`: проверка API-key identity;
4. `catalog/queries`: instruments и projection lag;
5. `accounts`: создание аккаунта и чтение его балансов;
6. `orders`: place, повтор с тем же idempotency key, query и cancel.

Каждый запуск использует уникальные command/account/order IDs. Pipeline не
изменяет ledger напрямую и не сохраняет credential в отчётах.

## Статус и отчёты

Терминал показывает каждый шаг сразу:

```text
✓ [health] readiness (4 ms)
✓ [authentication] current principal (2 ms)
✗ [orders] place order: ожидался HTTP 201, получен HTTP 503
```

Итоговые файлы создаются в `artifacts/api-flows/`:

- `report.json` — безопасный машиночитаемый результат;
- `junit.xml` — формат для CI test reporters;
- `summary.md` — таблица для GitHub Actions Job Summary.

Любой failed step завершает команду с ненулевым exit code. HTTP-вызов ограничен
`API_FLOW_REQUEST_TIMEOUT_MS` (5 секунд), startup ожидание —
`API_FLOW_STARTUP_TIMEOUT_MS` (60 секунд).

## Граница проверки

Pipeline подтверждает доступность transport-сценариев reference application.
Он не заменяет системный E2E settlement: текущий локальный `TradingCommandPort`
принимает команды in-memory и не связывает REST place order с реальным
sequencer/settlement adapter. После подключения production application port в
pipeline следует добавить funding → match → settlement → projection flow.
