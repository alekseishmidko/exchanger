# Pilot performance baseline

Статус: measured. Дата: 2026-09-08.

Профиль: Node.js 20.19.5, 2 000 локальных matching commands, без сети и DB.

| Metric | Observed | Regression budget |
| --- | ---: | ---: |
| matching p50 | 0.00088 ms | < 10 ms |
| matching p95 | 0.00280 ms | < 25 ms |
| matching p99 | 0.00988 ms | < 100 ms |
| matching max | 0.333 ms | informational |
| WebSocket-style fan-out | 500 clients × 100 events | все 50 000 deliveries |
| projection lag fixture | source 10, applied 0 | lag = 10 |
| event-log restore RTO | 2.61 ms for 10 000 events | < 1 000 ms |
| event-log restore RPO | 0 accepted events lost | 0 |

Значения являются локальным regression baseline, а не production SLA. Реальные
p50/p95/p99 должны повторно измеряться с PostgreSQL, broker, TLS/WebSocket и
целевым количеством соединений.
