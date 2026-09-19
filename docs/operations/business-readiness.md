# Business readiness: как доказать, что биржа работает

## Короткий ответ

Проект считается готовым не по одному `pnpm test`, а по цепочке доказательств:
контракты, доменные инварианты, публичные transport flows, durable persistence,
recovery, нагрузка, adversarial inputs и подписанный release report. Если хотя
бы один слой не пройден, это не production-ready, даже если приложение
запускается и Swagger красивый.

## Быстрая локальная проверка

Одной командой:

```bash
pnpm ready:quick
```

Эквивалентный ручной набор:

```bash
pnpm security:check
pnpm lint
pnpm typecheck
pnpm contracts:check
pnpm observability:check
pnpm adversarial:check
pnpm readiness:check
pnpm test
pnpm build
```

Эта группа отвечает на вопрос: “кодовая база воспроизводима, типобезопасна,
документированные API не разъехались, критичные unit/e2e/adversarial проверки
зелёные”. Она не доказывает устойчивость под production load.

## Проверка бизнес-флоу

Одной командой:

```bash
pnpm ready:business
```

| Бизнес-требование                                        | Что запускать                                                                                                | Что доказывает                                                                                        |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| account → balance → order → match → settlement → history | `pnpm --filter @exchange/backend test -- test/system.e2e-spec.ts --runInBand`                                | деньги резервируются, match создаёт trade, settlement создаёт postings, projections восстанавливаются |
| REST клиент не обходит auth/validation/idempotency       | `pnpm contracts:check` и `pnpm adversarial:check`                                                            | controller → application port, DTO validation, auth, object access, idempotency conflict              |
| повтор команды не создаёт повторный эффект               | `pnpm adversarial:check`, `test/system.e2e-spec.ts`                                                          | duplicate place/cancel/settlement возвращает прежний result                                           |
| ledger не теряет стоимость                               | `pnpm --filter @exchange/backend test -- src/modules/ledger/ledger.spec.ts --runInBand`                      | balanced postings, available/reserved invariants, compensation                                        |
| matching deterministic                                   | `pnpm --filter @exchange/backend test -- src/modules/trading/matching-engine --runInBand`                    | price-time priority, FIFO, IOC/FOK, replay                                                            |
| market data восстанавливается после gap/reconnect        | `pnpm --filter @exchange/backend test -- test/market-data.websocket.e2e-spec.ts --runInBand`                 | snapshot, ordered increments, private isolation                                                       |
| durable PostgreSQL adapters                              | `pnpm --filter @exchange/backend test -- src/modules/ledger/infrastructure/postgres.int-spec.ts --runInBand` | migrations, transaction rollback, durable idempotency, audit/projection storage                       |
| black-box dev приложение                                 | `pnpm api:flows`                                                                                             | реально поднятый HTTP server, readiness, auth, accounts, orders, projections                          |

## Проверка инфраструктурной готовности

```bash
pnpm postgres:backup-restore
pnpm load:smoke
pnpm load:average
CHAOS_ENVIRONMENT=staging CHAOS_ACK=isolated-test-only pnpm resilience:staging
```

Для release candidate дополнительно нужны scheduled/staging прогоны:

```bash
pnpm ready:rc
```

- `load:stress`, `load:spike`, `load:soak`, `load:breakpoint`;
- PostgreSQL failover, backend kill, contention, resource pressure;
- backup/restore и archive/restore на отдельном restore contour;
- проверка dashboards, alerts и runbooks человеком.

## Go/no-go правило

Полный локальный оркестратор:

```bash
pnpm ready:full
```

Он долгий: запускает extended load и staging resilience. Для продолжения после
ошибки используйте `READINESS_CONTINUE_ON_FAILURE=true pnpm ready:full`.

Production release допускается только если заполнен
`docs/operations/production-readiness-report-template.md` и в нём:

- указан build SHA, topology, dataset, resource limits и конфигурация;
- все обязательные suites зелёные или исключения имеют owner/deadline/risk acceptance;
- SLO/error budget не нарушен;
- reconciliation сходится;
- RTO/RPO практически измерены;
- rollback и emergency stop rehearsed до production deployment.

## Известные ограничения текущего состояния

- `api:flows` проверяет reference transport flow и пока не заменяет полный
  production REST → sequencer → matching → settlement → projection сценарий.
- Production capacity baseline ещё не принят; `ci-budget.json` является guard,
  а не SLA.
- Часть resilience gate остаётся открытой до quota-limited disk pressure,
  multi-client starvation/rate-limit runner и подписанного game day.
