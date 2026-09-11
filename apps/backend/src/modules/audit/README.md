# Audit log

`AuditLog` хранит append-only hash chain административных событий. Hash каждой
записи включает нормализованные поля и hash предыдущей записи. Метод
`verifyIntegrity` обнаруживает изменение содержимого, удаление и перестановку.

In-memory реализация предназначена для domain/failure tests. Production adapter
должен сохранять записи в отдельное WORM/object-lock хранилище, ограничивать
доступ ролью auditor и экспортировать метрики integrity/retention lag.

Audit details используют allow-list и не содержат API keys, токены и секреты.

## Operational log events

`audit.record.appended` сообщает sequence новой записи без её details;
`audit.integrity.failed` — несовпадение chain/hash. Эти operational events не
заменяют саму append-only запись и не меняют её retention.
