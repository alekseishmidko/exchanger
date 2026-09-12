# Exchange

Учебная биржа в виде pnpm workspace с NestJS backend и отдельным пакетом межмодульных контрактов.

## Быстрый старт

```bash
pnpm install --frozen-lockfile
pnpm dev
```

Окружение разработки в Docker:

```bash
pnpm docker:development
```

Docker публикует backend на `http://localhost:5001`, потому что порт `5000` в
macOS часто занят Control Center/AirPlay. При необходимости host-порт можно
переопределить без изменения Compose-файла:

```bash
BACKEND_HOST_PORT=5010 pnpm docker:development
```

После успешного запуска backend выводит в structured logs адрес сервера и, если
Swagger включён, строку `Документация доступна по адресу: ...`. Для запуска за
reverse proxy внешний адрес можно задать через `APPLICATION_PUBLIC_URL`.

Production-образ собирается и запускается в фоне одной командой:

```bash
pnpm docker:production
```

Безопасные базовые настройки хранятся в `.env.development.example` и
`.env.production.example`, а contract-тесты используют `.env.test.example`.
Поэтому Compose и Jest работают из чистого checkout.
Игнорируемые `.env.development` и `.env.production` являются необязательными
локальными override-файлами и применяются после example. В production-файл
нельзя добавлять секреты: секретные значения передаются через secret storage или
deployment environment.

Проверка приложения при локальном запуске через `pnpm dev`:

```bash
curl http://localhost:5000/health
```

Swagger UI в development доступен по `http://localhost:5000/docs`, а
машиночитаемый контракт — по `/docs/openapi.json` и `/docs/openapi.yaml`.
WebSocket market-data использует Socket.IO namespace
`http://localhost:5000/market-data`; версионируемый протокол описан в
[AsyncAPI](docs/asyncapi/market-data.yaml).

Проверка Docker development окружения:

```bash
curl http://localhost:5001/health
```

Автоматическая проверка групп API endpoints с пошаговым статусом и отчётами:

```bash
pnpm api:flows:development
```

Если development-контейнер уже работает, достаточно `pnpm api:flows`.

Описание сценариев и форматов отчёта: [API flow pipeline](docs/api-flow-pipeline.md).

Полный observability-контур (OpenTelemetry Collector, Tempo, Prometheus,
Alertmanager и Grafana) запускается командой `pnpm docker:observability`. Grafana доступна на
`http://localhost:3000`, Prometheus — на `http://localhost:9090`. Проверка
telemetry contracts, cardinality, dashboards и alerts без Docker выполняется
через `pnpm observability:check`; подробности — в
[observability guide](docs/observability/alerts.md).

Для Docker development Swagger UI открыт по `http://localhost:5001/docs`.
WebSocket namespace доступен по `http://localhost:5001/market-data`.

Перед отправкой изменений запускается полный gate:

```bash
pnpm security:check && pnpm format:check && pnpm lint && pnpm typecheck && pnpm contracts:check && pnpm test && pnpm build
```

Правила разработки и Definition of Done описаны в [project standards](docs/project-standards.md), рабочий checklist — в [development checklist](docs/development-checklist.md).
