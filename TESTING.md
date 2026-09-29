# Команды тестирования

Этот файл — точка входа для локальных проверок. Все команды выполняются из
корня проекта.

## Подготовка окружения

Выполнять после нового checkout или изменения lock-файла:

```bash
nvm install
nvm use
corepack enable
pnpm install --frozen-lockfile
```

Проект требует Node `22.23.3` и pnpm `10.15.0`. `verify:local` остановится до
тестов, если версии отличаются.

## 1. Полная локальная проверка

Запускать после крупных изменений, перед release candidate или когда затронуты
API, Docker/runtime-конфигурация и производительность одновременно:

```bash
# Полный обязательный local/CI gate: randomized, lint, typecheck, contracts,
# PostgreSQL, Redis, tests, build, clean checkout, security и container checks.
pnpm verify:local

# Black-box REST/WebSocket сценарии в изолированном Docker-окружении.
pnpm api:flows

# Короткая проверка приложения под реальной HTTP/WebSocket нагрузкой.
pnpm load:smoke
```

Первые три команды должны завершиться успешно. Отчёты сохраняются в `artifacts/`.

Проверки реального Twelve Data выполняются отдельно от обязательного CI. REST
smoke расходует один API credit, WebSocket smoke временно занимает один
subscription credit. Ключ читается только из ignored `.env.development`, не
попадает в URL REST-запроса, console output или artifact:

```bash
pnpm twelve-data:smoke:test  # offline contract tests при изменении adapter/smoke
pnpm twelve-data:smoke       # один live /quote request после настройки ключа
pnpm twelve-data:ws-smoke:test # offline WebSocket canary contract
pnpm twelve-data:ws-smoke      # один symbol до первого подтверждённого tick
```

## 2. Перед pull request

Обязательная команда непосредственно перед push/PR:

```bash
pnpm verify:local
```

Это тот же набор обязательных проверок, который использует GitHub verify job.
Команда выполняется fail-fast и сохраняет отдельные stdout/stderr логи в
`artifacts/backend-checks/`.

Обычный `pnpm test` для PR **недостаточен**: он не включает PostgreSQL, Redis,
randomized, clean-checkout, security и production-container проверки.

## 3. Нагрузочное тестирование

Docker должен быть запущен. Профили создают изолированное окружение и сохраняют
результаты в `artifacts/load/`.

```bash
# Быстрый smoke: после изменений HTTP/WS endpoints или перед обычным PR.
pnpm load:smoke

# Типичная рабочая нагрузка: перед merge изменений hot path, БД или cache.
pnpm load:average

# Резкий скачок трафика: перед релизом rate limits, queue/backpressure и WS.
pnpm load:spike

# Продолжительная высокая нагрузка: перед релизом производительных изменений.
pnpm load:stress

# Длительный прогон на утечки и деградацию. Не запускать как быстрый PR-check.
pnpm load:soak

# Поиск предела системы. Только в изолированном окружении.
pnpm load:breakpoint

# Все профили последовательно; самый долгий вариант.
pnpm load:all
```

Подробности профилей: [`docs/testing/load-testing.md`](docs/testing/load-testing.md).

## 4. Быстрый цикл разработки

Запускать ближайшую к изменению группу во время TDD, затем перед PR обязательно
выполнить `pnpm verify:local`.

```bash
# Чистая бизнес-логика и небольшие классы без внешней инфраструктуры.
pnpm --filter @exchange/backend test:unit

# Несколько модулей вместе, но без PostgreSQL/Redis.
pnpm --filter @exchange/backend test:component

# HTTP/WebSocket/Nest boundaries.
pnpm --filter @exchange/backend test:e2e

# Все обычные backend suites без PostgreSQL/Redis integration projects.
pnpm --filter @exchange/backend test

# Workspace tests: contracts + backend; всё ещё без integration projects.
pnpm test

# Статический контроль после изменения TypeScript.
pnpm lint
pnpm typecheck
pnpm format:check
```

Один файл или один тест:

```bash
# Один spec-файл.
pnpm --filter @exchange/backend test:e2e test/realtime-market.e2e-spec.ts --runInBand

# Один test по названию.
pnpm --filter @exchange/backend test:e2e \
  src/modules/auth/human-auth.e2e-spec.ts \
  --runInBand -t "uses case-insensitive login"
```

## 5. База данных и cache

Запускать после изменения repositories, migrations, sessions, quote cache,
idempotency или distributed coordination.

```bash
# Сам поднимает изолированный Redis и запускает Redis integration suites.
pnpm redis:check

# Требует доступный PostgreSQL и явный URL.
POSTGRES_URL=postgresql://postgres:postgres@127.0.0.1:5432/exchange_test \
  pnpm --filter @exchange/backend test:integration:postgres

# Прямой Redis integration command требует REAL_REDIS_TESTS=true и REDIS_URL;
# обычно удобнее и безопаснее использовать pnpm redis:check.
REAL_REDIS_TESTS=true REDIS_URL=redis://127.0.0.1:6379 \
  pnpm --filter @exchange/backend test:integration:redis
```

Integration-команды специально падают, а не пропускают suites, если зависимость
не настроена.

## 6. API, контракты и Twelve Data/realtime

```bash
# OpenAPI/AsyncAPI, transport inventory и совместимость контрактов.
pnpm contracts:check

# Некорректный ввод, authorization boundaries и abuse-сценарии.
pnpm adversarial:check

# Изолированные black-box REST/WebSocket flows.
pnpm api:flows

# Бизнес-сценарии в development Docker environment.
pnpm business:e2e

# При точечной работе с realtime-модулем.
pnpm --filter @exchange/backend test:unit \
  src/modules/realtime-market/realtime-market.spec.ts \
  src/modules/realtime-market/realtime-execution.spec.ts --runInBand
pnpm --filter @exchange/backend test:e2e \
  test/realtime-market.e2e-spec.ts \
  test/realtime-market.websocket.e2e-spec.ts --runInBand
```

## 7. Coverage и качество тестов

```bash
# Coverage contracts и backend. Использовать при добавлении логики и тестов.
pnpm test:cov

# Проверка десяти seeds, изоляции каждого auth test и open handles.
pnpm test:randomized

# Проверяет, что Jest действительно применяет заявленные CLI options.
pnpm test:options

# Дважды собирает и тестирует проект в чистых Node 22 containers.
pnpm clean-checkout:check
```

Воспроизведение конкретного случайного порядка:

```bash
pnpm --filter @exchange/backend test:e2e \
  src/modules/auth/human-auth.e2e-spec.ts \
  --runInBand --randomize --seed=20260928 --showSeed
```

Диагностика незакрытых timers/sockets/subscribers:

```bash
pnpm --filter @exchange/backend test:e2e \
  src/modules/auth/human-auth.e2e-spec.ts \
  --runInBand --detectOpenHandles
```

## 8. Security и production container

Запускать после изменения зависимостей, Dockerfile, auth/security, environment
validation или production build/deploy.

```bash
pnpm security:check
pnpm security:audit:prod
pnpm security:audit:all
pnpm security:artifact
pnpm container:check
```

## 9. Release и staging readiness

Эти сценарии шире обычного PR gate:

```bash
# Быстрый набор readiness-проверок без полного staging цикла.
pnpm ready:quick

# Бизнес-потоки, staging и API flows.
pnpm ready:business

# Release candidate: добавляет load smoke/average и backup/restore.
pnpm ready:rc

# Максимальный staging-набор: все load profiles, backup/restore и resilience.
pnpm ready:full
```

`ready:full` запускать только в подготовленном изолированном staging-контуре: он
долгий и включает fault/resource injection. Команда устанавливает interlock
`CHAOS_ACK=isolated-test-only` для своего staging resilience step; не направляйте
этот профиль на общий или production-контур. Подробнее:
[`docs/testing/chaos-testing.md`](docs/testing/chaos-testing.md).

## Короткая памятка

| Ситуация | Что запускать |
| --- | --- |
| Во время TDD | Ближайший `test:unit`, `test:component` или `test:e2e` |
| Изменены repository/cache/migration | Соответствующий PostgreSQL/Redis integration gate |
| Изменены REST/WS/contracts | `pnpm contracts:check` и `pnpm api:flows` |
| Изменён hot path | `pnpm load:smoke`, затем `pnpm load:average` |
| Перед каждым PR | `pnpm verify:local` |
| Большое изменение/release candidate | Полная локальная проверка из раздела 1 |
| Production/staging release | `pnpm ready:rc` или осознанно `pnpm ready:full` |
