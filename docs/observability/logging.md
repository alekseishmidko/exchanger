# Structured logging

## Формат записи

Production использует JSON Lines: одна завершённая JSON record на строку stdout.
Обязательные поля нельзя удалять или переименовывать в рамках текущей версии:

| Поле                   | Значение                                                        |
| ---------------------- | --------------------------------------------------------------- |
| `timestamp`            | UTC ISO-8601 время записи                                       |
| `level`                | `debug`, `info`, `warn` или `error`                             |
| `service`              | стабильное имя сервиса (`SERVICE_NAME`)                         |
| `module`               | источник boundary: `gateway`, `ledger`, `settlement` и т. п.    |
| `event`                | имя из compile-time каталога `LOG_EVENTS`                       |
| `traceId`, `spanId`    | активный OpenTelemetry context либо `null`                       |
| `environment`          | `development`, `test` или `production`                          |
| `correlationId`        | идентификатор полного пользовательского потока либо `null`      |
| `causationId`          | command/event, непосредственно породивший действие, либо `null` |
| `commandId`, `eventId` | безопасные технические identifiers либо `null`                  |
| `outcome`              | `success`, `rejected`, `retry`, `failure` или `recovered`       |
| `durationMs`           | monotonic duration terminal boundary либо `null`                |
| `metadata`             | только allow-listed операционные признаки без payload           |

Startup events отдельно указывают фактический `bindAddress`, внешний `publicUrl`,
`buildVersion` и `environment`. `system.started` появляется только после
успешного bind; `system.swagger.ready` — только если документация опубликована.

## Уровни и terminal outcomes

- `debug` — sampled framework diagnostics без business payload;
- `info` — успешное принятие, применение, recovery и штатный shutdown;
- `warn` — ожидаемый validation/authorization rejection или очередной retry;
- `error` — исчерпанный retry, dependency failure, DLQ и integrity failure.

Duplicate/idempotent retry не получает второй business-success: callback
`IdempotencyStore` не выполняется повторно, а projection duplicate использует
отдельное событие `projection.duplicate` с outcome `recovered`.

## Каталог событий

| Boundary    | Success/recovery                                                   | Rejection/failure                              |
| ----------- | ------------------------------------------------------------------ | ---------------------------------------------- |
| System      | `system.started`, `system.swagger.ready`, `system.shutdown`        | `system.framework`                             |
| HTTP        | `http.request.completed`                                           | `http.request.rejected`                        |
| WebSocket   | `websocket.connected`, `websocket.subscribed`                      | `websocket.rejected`                           |
| Health      | `health.liveness.succeeded`, `health.readiness.succeeded`          | `health.dependency.failed`                     |
| Gateway     | `gateway.command.accepted`                                         | `gateway.command.rejected`                     |
| Instruments | `instrument.changed`                                               | `instrument.rejected`                          |
| Sequencer   | `sequencer.command.applied`                                        | `sequencer.command.rejected`                   |
| Matching    | `matching.order.processed`                                         | `matching.order.rejected`                      |
| Settlement  | `settlement.applied`                                               | `settlement.retry`, `settlement.rejected`      |
| Ledger      | `ledger.command.applied`                                           | `ledger.command.rejected`                      |
| Event log   | `event-log.appended`, `event-log.consumed`, `event-log.recovered`  | `event-log.timeout`, `event-log.dead-lettered` |
| Projections | `projection.applied`, `projection.duplicate`, `projection.rebuilt` | `projection.gap`                               |
| Admin       | `admin.action.applied`                                             | `admin.action.rejected`                        |
| Audit       | `audit.record.appended`                                            | `audit.integrity.failed`                       |

## Redaction и stack traces

Logger рекурсивно заменяет `[REDACTED]` для authorization/cookie/API-key,
password/secret/token, user/account identifiers и amount/price/quantity. Canary
patterns обнаруживают Bearer credentials, `ex_...`, connection strings и
`api_key=...` даже под нейтральным ключом. Controllers и consumers не должны
передавать headers, cookies, DTO, order book, postings либо полный event payload
в `metadata`.

Exception message не считается безопасным полем. Внешнее событие содержит только
allow-listed error type/code. Stack создаётся лишь для защищённого internal event
с `internal: true`; он не попадает в HTTP/WebSocket response и не должен
экспортироваться в пользовательские dashboards.

## Sampling, overhead и retention

`LOG_SAMPLE_LIMIT` задаёт число одинаковых low-priority events на окно
`LOG_SAMPLE_WINDOW_MS`. Значения по умолчанию — 100 событий за 10 секунд.
`error`, security rejections и audit events обходят sampling. Logger не вызывается
внутри matching loops и на каждом fan-out message. Benchmark сериализует 10 000
records и фиксирует CPU/allocation budget; production нагрузочный профиль должен
дополнительно измерять stdout collector backpressure.

Операционные логи рекомендуется хранить 30 дней online и 90 дней в дешёвом
архиве, если локальные требования не задают больший срок. Security events — не
меньше 180 дней. Audit retention определяется отдельной политикой и не зависит от
удаления operational logs.

## Связанные материалы

- [ADR 0005](../adr/0005-structured-operational-logging.md)
- [Runbook поиска потока](../runbooks/log-correlation.md)
- [Audit policy](../admin-risk-audit.md)
