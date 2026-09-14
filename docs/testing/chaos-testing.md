# Resilience и chaos testing

## Назначение и границы

Chaos suite проверяет поведение системы во время контролируемого отказа, а не
только после него. Базовый автоматизированный сценарий продолжает REST/WebSocket
average workload, отключает observability stack, проверяет business readiness,
возвращает telemetry services и выполняет reconciliation.

Fault injection разрешён только при одновременном выполнении двух условий:

```bash
CHAOS_ENVIRONMENT=development-compose \
CHAOS_ACK=isolated-test-only \
pnpm chaos:observability
```

Production и произвольное имя окружения runner отвергает до первого Docker
вызова. Каждый run получает отдельный Compose project и каталог
`artifacts/chaos/<runId>`. Запуск рядом с важным локальным контейнером запрещён,
поскольку host-порты development topology фиксированы.

## Каталог и статусы

- `automated` — black-box fault действительно вводится под k6 workload;
- `component` — fault воспроизводится на application/domain boundary без сети;
- `blocked` — topology не содержит dependency, необходимую для честной проверки.

Текущий runtime использует in-memory command, ledger и event-log adapters.
Поэтому SIGKILL с RPO=0, PostgreSQL packet loss/deadlock/read-only и rolling
partition ownership нельзя объявить пройденными. Полный перечень и владельцы
зафиксированы в `tests/chaos/scenarios.mjs` и `failure-matrix.md`.

## Timeline observability-outage

1. Runner валидирует safety interlock и поднимает изолированный SUT.
2. `/health/ready` должен стать доступен за bounded startup timeout.
3. В backend отправляется canary credential для последующей проверки redaction.
4. Отдельным процессом запускается k6 average workload.
5. После `CHAOS_INJECT_AFTER_MS` останавливаются Collector, Tempo, Prometheus,
   Alertmanager и Grafana; backend и k6 продолжают работу.
6. Readiness обязана остаться `200`: observability не является критичной business
   dependency и не должна блокировать trading path.
7. После `CHAOS_FAULT_DURATION_MS` services запускаются; RTO измеряется до
   готовности Prometheus.
8. Runner ожидает k6, проверяет thresholds, duplicate effect, число принятых
   команд, audit integrity и отсутствие canary в backend logs.
9. Окружение удаляется в `finally`, отчёты остаются CI artifacts.

Настройки timeline имеют bounded defaults: нагрузка 20 секунд, fault начинается
через 5 секунд и длится 5 секунд. Для воспроизведения передайте сохранённый
`CHAOS_SEED`; пока сценарий не использует random branching, seed остаётся
идентификатором будущего расширения и частью evidence.

## Артефакты и критерии

- `report.json` — итог, failures, RTO/RPO и reconciliation;
- `timeline.json` — точные действия и offsets;
- `summary.md` — GitHub Job Summary;
- `load/` — k6 raw output, thresholds и latency trend;
- `backend.log` — diagnostics с принудительной заменой canary.

Pipeline завершается ненулевым кодом при failed k6 thresholds, отсутствии хотя бы
одной accepted command, любом `load_accepted_visibility_failure_rate`, duplicate
effect, нарушении readiness, audit integrity или redaction. RPO=0 записывается
только при строгом `visibility failure rate == 0`; в observability-сценарии это
означает, что отключение telemetry не потеряло принятые workload-команды, но не
является доказательством RPO при backend/database crash.

## Stop conditions и emergency abort

Немедленно остановить сценарий, если обнаружены: production environment,
неожиданный Compose project, утечка credential/private data, audit integrity
failure, отрицательный баланс, неконтролируемый рост disk/memory, влияние на
соседнее окружение или отсутствие возможности выполнить cleanup.

Emergency abort:

```bash
docker compose \
  -f docker-compose.development.yml \
  -f docker-compose.observability.yml \
  -f docker-compose.load.yml \
  down --volumes --remove-orphans
```

Перед ручным game day оператор обязан записать точный `COMPOSE_PROJECT_NAME` и
проверить его через `docker compose ps`. Blast radius ограничен одним ephemeral
project, development credentials и тестовыми данными с runId. Запрещены shared
production database, broker, secret manager и public DNS targets.

## Game day evidence

Автоматический отчёт не заменяет человеческую проверку runbooks. Для закрытия
gate приложить: дату/build SHA/environment, scenario/seed, ссылки на artifacts,
фактические RTO/RPO, сработавшие alerts, имена operator/reviewer/incident owner,
подписи участников и follow-up actions с владельцем и сроком.
