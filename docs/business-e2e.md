# Black-box business E2E

`pnpm business:e2e` запускает изолированный development compose и выполняет
buyer/seller сценарий только через публичные REST/WebSocket контракты.
`pnpm business:e2e:staging` запускает production-like staging compose с
PostgreSQL, ingress, двумя backend replicas, миграциями и SIGKILL/RPO proof; эта
команда используется в `ready:business`, `ready:rc` и `ready:full`.
`pnpm business:e2e:check` выполняет тот же сценарий против уже запущенного
окружения.

## Что проверяет pipeline

- выпуск независимых buyer/seller API keys через admin auth endpoint;
- создание buyer/seller accounts через `/api/v1/accounts`;
- funding через авторизованный admin balance command;
- exact, partial и multi-fill crossing orders через `/api/v1/orders`;
- lifecycle `durableStatus`, `executionStatus`, `orderStatus`;
- passive maker price и maker/taker стороны в trade history;
- balance/order/trade projections обеих сторон;
- public book/trades/ticker и private user WebSocket streams;
- отсутствие private stream leakage между buyer и seller;
- idempotent retry без второго business effect;
- optional SIGKILL/restart proof с `BUSINESS_E2E_SIGKILL_COMMAND`;
- финальную reconciliation через `/api/v1/admin/reconciliation`.

Development profile полезен для быстрой отладки UI/API, но не является
доказательством durable recovery: in-memory credentials/state могут исчезнуть
после restart. Для закрытия MVP gate используется только
`pnpm business:e2e:staging`.

## Артефакты

По умолчанию development-файлы сохраняются в `artifacts/business-e2e/`, а
staging-файлы — в `artifacts/business-e2e-staging/`:

- `report.json` — status, build SHA, topology, failures и финальная reconciliation;
- `timeline.json` — последовательность HTTP/WS/check событий без API keys;
- `websocket-transcript.json` — полученные public/private envelopes;
- `metrics.prom` — snapshot `/internal/metrics`;
- `logs.txt` — вывод команды `BUSINESS_E2E_LOG_COMMAND` или явная пометка, что сбор не настроен;
- `traces.json` — вывод команды `BUSINESS_E2E_TRACE_COMMAND` или явная пометка, что сбор не настроен;
- `summary.md` — краткий отчёт для GitHub Actions.

## Переменные окружения

| Переменная | Назначение |
| --- | --- |
| `BUSINESS_E2E_BASE_URL` | REST endpoint, default `http://localhost:5001` |
| `BUSINESS_E2E_WS_URL` | Socket.IO namespace, default `${BASE_URL}/market-data` |
| `BUSINESS_E2E_ADMIN_KEY` | admin key для setup/reconciliation |
| `BUSINESS_E2E_SECOND_ADMIN_KEY` | второй admin для dual-control approval |
| `BUSINESS_E2E_SIGKILL_COMMAND` | явная команда kill/restart для RPO=0 proof |
| `BUSINESS_E2E_LOG_COMMAND` | команда сбора backend/dependency logs в staging |
| `BUSINESS_E2E_TRACE_COMMAND` | команда выгрузки trace evidence из Tempo/OTel backend |
| `BUSINESS_E2E_REPORT_DIR` | каталог артефактов |

Если `BUSINESS_E2E_SIGKILL_COMMAND` не задан, pipeline намеренно завершится
ошибкой: пункт SIGKILL/RPO=0 нельзя считать доказанным.

## Почему это black-box

Скрипт не импортирует `MatchingEngine`, `SettlementService`, projection fixtures
или `TradingCommandPort`. Все действия выполняются через REST/WebSocket, а
проверки используют только публичные query endpoints и admin reconciliation.
