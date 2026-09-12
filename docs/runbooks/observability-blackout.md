# Runbook: observability blackout

1. Подтвердить blackout независимым synthetic probe `/health/live` и бизнес-
   smoke flow. Не переводить backend в not-ready только из-за Collector/Grafana.
2. Проверить `up`, Collector health, `otelcol_*` queue/export errors, свободное
   место Prometheus/Tempo и DNS между containers.
3. Если бизнес-поток здоров, отключить OTLP export через
   `OTEL_TRACES_ENABLED=false` при следующем controlled restart; structured logs
   и audit продолжают работать. Не увеличивать очередь бесконечно.
4. Если stdout collector создаёт backpressure, сохранить audit sink, увеличить
   sampling operational logs и ограничить debug. Settlement/reconciliation
   события не отбрасывать.
5. После восстановления убедиться, что alert resolved, ingestion вернулся к
   baseline, queue drained и новых reconciliation differences нет. Telemetry,
   потерянная сверх bounded queue, не восстанавливается; это фиксируется в
   incident timeline.
6. Эскалация: Platform primary → storage owner через 10 минут; Trading/Ledger
   подключаются немедленно, если blackout совпадает с business SLO violation.

Диагностика без UI: `docker compose -f docker-compose.development.yml -f
docker-compose.observability.yml logs otel-collector prometheus tempo` и запрос
backend `/internal/metrics`. В incident report указать начало/конец, оценку
потерянных spans/samples, влияние на SLO и corrective action.
