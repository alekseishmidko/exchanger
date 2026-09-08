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

Production-образ собирается и запускается в фоне одной командой:

```bash
pnpm docker:production
```

Конфигурация окружений находится в `.env.development` и `.env.production`. В production-файл нельзя добавлять секреты: секретные значения передаются через secret storage или deployment environment с переопределением переменных.

Проверка приложения при локальном запуске через `pnpm dev`:

```bash
curl http://localhost:5000/health
```

Swagger UI в development доступен по `http://localhost:5000/docs`, а
машиночитаемый контракт — по `/docs/openapi.json` и `/docs/openapi.yaml`.

Проверка Docker development окружения:

```bash
curl http://localhost:5001/health
```

Для Docker development Swagger UI открыт по `http://localhost:5001/docs`.

Перед отправкой изменений запускается полный gate:

```bash
pnpm security:check && pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

Правила разработки и Definition of Done описаны в [project standards](docs/project-standards.md), рабочий checklist — в [development checklist](docs/development-checklist.md).
