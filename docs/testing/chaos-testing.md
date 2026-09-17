# Resilience и chaos testing

## Назначение и границы

Chaos suite проверяет поведение системы во время контролируемого отказа, а не
только после него. Базовый автоматизированный сценарий продолжает REST/WebSocket
average workload, отключает observability stack, проверяет business readiness,
возвращает telemetry services и выполняет reconciliation.

Durable-сценарии выполняются в отдельном `docker-compose.staging.yml`. Он одной
командой поднимает PostgreSQL, migrations, PostgreSQL transactional outbox,
Toxiproxy, две backend replicas, TLS ingress, OpenTelemetry, Prometheus, Tempo,
Alertmanager и Grafana. k6 запускается отдельным container/profile и не делит
CPU/memory limit с SUT.

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

Для production-like сценариев используется отдельная команда:

```bash
CHAOS_ENVIRONMENT=staging \
CHAOS_ACK=isolated-test-only \
pnpm resilience:staging
```

Обычная проверка topology без fault injection запускается одной командой
`pnpm staging:up`, доступна по `https://localhost:5443` и останавливается через
`pnpm staging:down`. Сертификат Caddy выпущен локальным internal CA; k6 в этом
изолированном контуре явно включает `insecureSkipTLSVerify`. Production profile
не содержит Toxiproxy/fault-agent и не публикует их control API.

## Каталог и статусы

- `automated` — black-box fault действительно вводится под k6 workload;
- `component` — fault воспроизводится на application/domain boundary без сети;
- `staging` — fault вводится в durable двухрепличном Compose-контуре;
- `blocked` — topology не содержит dependency, необходимую для честной проверки.

Staging runtime использует только PostgreSQL adapters. Event log выбран как
transactional outbox, поэтому DB и event append имеют одну ACID/network boundary
`postgres-outbox`; им нельзя вводить независимый network fault, не разрушив
атомарность принятого ADR. Полный перечень и владельцы зафиксированы в
`tests/chaos/scenarios.mjs` и `failure-matrix.md`.

## Durable staging scenarios

- `network-faults`: latency, bandwidth, timeout, reset, temporary disconnect и
  100% bounded packet loss; readiness обязана перейти 503 и вернуться 200;
- `postgres-contention`: table lock/pool pressure, настоящий deadlock и временный
  database-wide read-only default с обязательным восстановлением;
- `durable-process-kill`: SIGKILL active replica после accepted response,
  повтор прежнего idempotency key и takeover второй replica;
- `rolling-ownership`: A → B → A, возрастающий fencing epoch и непрерывные
  sequence 1, 2, 3;
- `controls-under-load`: user freeze/unfreeze и dual-control global stop/resume
  при продолжающемся command workload.

В `controls-under-load` dual-control request и approval выполняются через одну
живую admin replica, пока command workload не останавливается. Applied
freeze/circuit state сохраняется в PostgreSQL и сразу действует для обеих
реплик. Pending approval пока остаётся process-local состоянием `AdminService`:
его cross-replica approval и восстановление после restart не доказаны и должны
быть закрыты отдельным durable admin-action repository до resilience gate.

Каждый сценарий получает чистые volumes. После fault runner сравнивает terminal
commands, outbox events, sequence gaps, balances, posting sets, offsets,
projection checkpoints и audit chain. Любое расхождение, RPO больше нуля,
credential canary в logs или failed cleanup делает pipeline красным.

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

Для durable staging runner аварийный путь сначала удаляет все Toxiproxy toxics и
`tc netem qdisc`, затем всегда выполняет:

```bash
docker compose -f docker-compose.staging.yml \
  --profile load --profile fault-injection \
  down --volumes --remove-orphans
```

Fault-agent имеет только `NET_ADMIN`, разделяет network namespace Toxiproxy и
не получает Docker socket. Его entrypoint требует одновременно
`CHAOS_ENVIRONMENT=staging` и `CHAOS_ACK=isolated-test-only`. Network faults
ограничены PostgreSQL/outbox proxy, packet loss снимается в `finally`.

Перед ручным game day оператор обязан записать точный `COMPOSE_PROJECT_NAME` и
проверить его через `docker compose ps`. Blast radius ограничен одним ephemeral
project, development credentials и тестовыми данными с runId. Запрещены shared
production database, broker, secret manager и public DNS targets.

## Game day evidence

Автоматический отчёт не заменяет человеческую проверку runbooks. Для закрытия
gate приложить: дату/build SHA/environment, scenario/seed, ссылки на artifacts,
фактические RTO/RPO, сработавшие alerts, имена operator/reviewer/incident owner,
подписи участников и follow-up actions с владельцем и сроком.
