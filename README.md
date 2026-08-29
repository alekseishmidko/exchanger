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

Production-образ собирается и запускается в фоне одной командой:

```bash
pnpm docker:production
```

Конфигурация окружений находится в `.env.development` и `.env.production`. В production-файл нельзя добавлять секреты: секретные значения передаются через secret storage или deployment environment с переопределением переменных.

Проверка приложения:

```bash
curl http://localhost:5000/health
```

Перед отправкой изменений запускается полный gate:

```bash
pnpm security:check && pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

Правила разработки и Definition of Done описаны в [project standards](docs/project-standards.md), рабочий checklist — в [development checklist](docs/development-checklist.md).
