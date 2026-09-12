# Observability: structured logging

`ObservabilityModule` глобально предоставляет `StructuredLogger`,
`LoggingContext`, `TelemetryService` и `MetricsService`. HTTP interceptor создаёт/валидирует `x-correlation-id`,
измеряет monotonic duration и пишет ровно одно terminal event. WebSocket и
background consumers передают correlation/causation metadata явно через
versioned envelopes.

OpenTelemetry продолжает W3C context через HTTP, WebSocket и event log. Bounded
BatchSpanProcessor не выполняет network I/O в торговом hot path. Prometheus
registry публикуется на internal `/internal/metrics`; allow-list labels и
cardinality tests запрещают пользовательские IDs. Подробности: [metrics](../../../../../docs/observability/metrics.md),
[tracing](../../../../../docs/observability/tracing.md), [SLO](../../../../../docs/observability/slo.md),
[alerts](../../../../../docs/observability/alerts.md).

Logger принимает только события из `LOG_EVENTS`, формирует обязательную JSON
schema, выполняет recursive redaction и window sampling. Security, audit и error
events не семплируются. Прямой `console.*` запрещён ESLint/repository check.

Основные системные события: `system.started`, `system.swagger.ready`,
`system.shutdown`, `http.request.completed`, `http.request.rejected`. Полный
каталог, retention и runbook: [`docs/observability/logging.md`](../../../../../docs/observability/logging.md).
