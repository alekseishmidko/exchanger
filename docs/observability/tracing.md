# Distributed tracing

## Context propagation

Используется OpenTelemetry SDK и W3C `traceparent`. HTTP interceptor продолжает
валидный incoming parent или создаёт root `http.request`. WebSocket subscribe,
unsubscribe, resync и heartbeat принимают optional `trace` object. Command/event
envelope переносит `traceparent`; consumer открывает remote child span перед
вызовом handler. Некорректный carrier не доверяется и начинает новый trace.

`traceId`/`spanId` автоматически добавляются в structured logs. Метрики используют
их только как exemplars. Baggage не принимается, чтобы PII и unbounded metadata
не прошли через межмодульную границу.

## Каталог spans

`http.request` → `trading.command.admission` → `trading.sequencer.wait` →
`trading.matching.apply` → `trading.settlement.apply` → `ledger.commit` →
`event_log.append`; consumer продолжает цепочку через `event_log.consume` →
`projection.apply`. WebSocket boundary использует `websocket.message`.

Attributes ограничены 32 полями и 128 символами. ID-подобные attributes
централизованно отбрасываются. Допустимы command/event type, result, component и
protocol operation. Span не сериализует DTO, postings, order book или secret.

## Export и отказ

BatchSpanProcessor имеет очередь 2 048 spans, batch 256, задержку 5 s и timeout
1 s. Значения задаются `OTEL_BSP_*`. OTLP HTTP отправляется Collector-у, далее в
Tempo. Export выполняется после hot path; sync exception и failed callback
поглощаются adapter-ом и отражаются internal metric. При выключенном tracing
работает локальный no-network exporter, бизнес-код использует тот же port.

Readiness никогда не проверяет Collector, Tempo, Prometheus или Grafana.
Observability помогает диагностике, но не является критичной торговой
зависимостью. Graceful shutdown пытается flush; timeout не отменяет уже
зафиксированный business effect.

## Пример клиента

HTTP-клиент передаёт `traceparent: 00-<32 hex trace>-<16 hex span>-01`.
WebSocket-команда использует `{requestId, channel, instrumentId,
trace:{traceparent}}`. Полученный correlation ID остаётся прикладным ключом
поиска, trace ID описывает причинную execution tree; они не взаимозаменяемы.
