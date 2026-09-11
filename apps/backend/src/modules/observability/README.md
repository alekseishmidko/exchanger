# Observability: structured logging

`ObservabilityModule` глобально предоставляет `StructuredLogger` и
`LoggingContext`. HTTP interceptor создаёт/валидирует `x-correlation-id`,
измеряет monotonic duration и пишет ровно одно terminal event. WebSocket и
background consumers передают correlation/causation metadata явно через
versioned envelopes.

Logger принимает только события из `LOG_EVENTS`, формирует обязательную JSON
schema, выполняет recursive redaction и window sampling. Security, audit и error
events не семплируются. Прямой `console.*` запрещён ESLint/repository check.

Основные системные события: `system.started`, `system.swagger.ready`,
`system.shutdown`, `http.request.completed`, `http.request.rejected`. Полный
каталог, retention и runbook: [`docs/observability/logging.md`](../../../../../docs/observability/logging.md).
