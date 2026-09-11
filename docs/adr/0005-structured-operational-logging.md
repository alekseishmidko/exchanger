# ADR 0005: единый structured operational logger

Статус: accepted. Дата: 2026-09-11.

## Контекст

NestJS framework logger, Fastify request logger и самостоятельные сообщения
модулей создавали разные форматы. Такой поток нельзя надёжно искать по одной
команде, а случайная сериализация headers, DTO или exception могла раскрыть API
key, персональные либо финансовые данные. Логирование в циклах matching и fan-out
также способно нарушить latency budget.

## Решение

Используется собственный `StructuredLogger`, совместимый с Nest `LoggerService`.
Он внедряется глобальным `ObservabilityModule`; HTTP context переносится через
`AsyncLocalStorage`, а event/consumer boundaries дополнительно сохраняют
`correlationId` и `causationId` в envelope. Production sink пишет по одной JSON
record на строку в stdout для сбора контейнерной платформой.

Имена событий закрыты compile-time/runtime каталогом `LOG_EVENTS`. Запись всегда
содержит `timestamp`, `level`, `service`, `module`, `event`, `environment`,
`correlationId`, `causationId`, `commandId`, `eventId`, `outcome`, `durationMs` и
`metadata`. Прямой `console.*` запрещён ESLint и repository check.

Логи ставятся на transport/application boundaries и terminal state changes.
Итерации price levels, postings, projection rows и WebSocket fan-out не
логируются. Централизованная рекурсивная redaction удаляет credentials,
персональные identifiers и финансовые значения. Stack trace разрешён только при
явном `internal: true`; клиентские ошибки и обычные production события его не
получают. Window sampling ограничивает повторяющиеся info/warn, но error,
security и audit events не отбрасываются.

Audit log остаётся отдельной append-only hash chain. Operational logger помогает
диагностике, но не является доказательством административного действия и не
заменяет retention/object-lock требования аудита.

## Последствия

Dashboards и alerts могут опираться на стабильные event names и обязательные
поля. Добавление нового события требует изменения каталога, документации и
contract test. stdout sink остаётся неблокирующим только в пределах поведения
container runtime; production collector обязан применять buffering и собственный
backpressure вне request process.
