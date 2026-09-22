# Observability: structured logging

`ObservabilityModule` глобально предоставляет `StructuredLogger`,
`LoggingContext`, `TelemetryService` и `MetricsService`. HTTP interceptor
создаёт/валидирует `x-correlation-id`, измеряет monotonic duration и пишет
ровно одно terminal event. WebSocket и background consumers передают
correlation/causation metadata явно через versioned envelopes.

## Структура модуля

- `logging/` — `StructuredLogger`, `LoggingContext`, HTTP interceptor,
  lifecycle reporter и каталог `LOG_EVENTS`;
- `metrics/` — Prometheus registry, catalog имён/labels/buckets,
  cardinality policy и internal scrape controller;
- `tracing/` — OpenTelemetry adapter, bounded span exporter и публичные
  trace/span типы;
- `alerts/` — machine-checkable alert rules и synthetic alert evaluator;
- `observability.module.ts` — NestJS composition root, который связывает
  logging, metrics и tracing через DI.

Такая раскладка сохраняет внешний импорт через `../observability`, но внутри
показывает ответственность файла сразу по пути.

OpenTelemetry продолжает W3C context через HTTP, WebSocket и event log. Bounded
BatchSpanProcessor не выполняет network I/O в торговом hot path. Prometheus
registry публикуется на internal `/internal/metrics`; allow-list labels и
cardinality tests запрещают пользовательские IDs. Подробности: [metrics](../../../../../docs/observability/metrics.md),
[tracing](../../../../../docs/observability/tracing.md), [SLO](../../../../../docs/observability/slo.md),
[alerts](../../../../../docs/observability/alerts.md).

Metrics слой разделён на `metrics/metrics.catalog.ts`,
`metrics/metrics-label.policy.ts` и `metrics/metrics.ts`: catalog хранит имена,
labels и buckets, label policy ограничивает значения, а `MetricsService` только
регистрирует instruments и записывает observations.

Logger принимает только события из `LOG_EVENTS`, формирует обязательную JSON
schema, выполняет recursive redaction и window sampling. Security, audit и error
events не семплируются. Прямой `console.*` запрещён ESLint/repository check.

Основные системные события: `system.started`, `system.swagger.ready`,
`system.shutdown`, `http.request.completed`, `http.request.rejected`. Полный
каталог, retention и runbook: [`docs/observability/logging.md`](../../../../../docs/observability/logging.md).
