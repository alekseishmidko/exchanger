# Метрики

## Endpoint и модель данных

Backend публикует OpenMetrics на `/internal/metrics`. Маршрут исключён из public
OpenAPI; ingress разрешает его только Prometheus. `MetricsService` владеет
отдельным registry, allow-list имён/labels и едиными histogram buckets от 0.5 ms
до 5 s. Это позволяет вычислять p50/p95/p99 через `histogram_quantile`, не
перенастраивая bucket contract между окружениями.

RED-сигналы: `exchange_http_requests_total`,
`exchange_http_request_duration_seconds`, WebSocket count/duration. USE-сигналы:
default Node.js CPU/heap/GC/event-loop metrics и
`exchange_resource_{utilization,saturation}_ratio`,
`exchange_resource_errors_total` для PostgreSQL, pool, consumers и fan-out.

Бизнес-сигналы: command accepted/rejected, trades, settlement result,
reconciliation differences, sequence gaps, projection/consumer lag и circuit
breaker state. `exchange_market_data_freshness_seconds` вычисляет возраст
последней публикации при каждом scrape. Денежные значения, payload и пользовательские identifiers в
метрики не записываются.

## Cardinality contract

Разрешены только labels из `METRIC_LABEL_POLICY`. `userId`, `accountId`,
`orderId`, `commandId`, `eventId`, socket ID и raw URL запрещены. UUID/path ID
нормализуется в `:id`; неизвестная причина становится `unknown`, неизвестный
instrument — `other`. Нужный конкретный flow ищется через trace/log, а не label.
Contract test генерирует 500 уникальных ID и доказывает, что число series не
растёт.

Histogram/counter samples в OpenMetrics содержат exemplar `trace_id/span_id`,
если запись выполнена внутри active span. Exemplar не является постоянным label
и позволяет перейти из p99 spike в Tempo.

## Объём, retention и loss budget

Pilot budget: до 20 custom series на instance для базового трафика, scrape 15 s,
порядка 576 000 samples/day на 100 series. Prometheus ограничен 10 GB и 15 днями.
Фактический `prometheus_tsdb_head_series` и ingestion rate фиксируются после
каждого staging load test. Steady-state loss budget — не более 1% non-critical
trace spans; при защитном сбросе во время overload доля может быть выше и обязана
вызвать alert. Audit, settlement и reconciliation business records не
являются telemetry и не могут теряться вместе с ней.

Автоматический volume fixture создаёт 1 000 spans при diagnostic limit 100:
summary остаётся меньше 64 KiB, exposition — меньше 256 KiB, а 900 вытесненных
spans отражаются `exchange_telemetry_dropped_total`. Это проверяет локальную
защиту; фактический OTLP compression ratio измеряется отдельно в staging.

`exchange_telemetry_dropped_total` показывает queue/cardinality protection,
`exchange_telemetry_export_failures_total` — отказ exporter. Рост обоих не меняет
readiness, но вызывает blackout alert.
