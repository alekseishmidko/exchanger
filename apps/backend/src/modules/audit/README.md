# Audit log

`AuditLog` хранит append-only hash chain административных событий. Hash каждой
записи включает нормализованные поля и hash предыдущей записи. Метод
`verifyIntegrity` обнаруживает изменение содержимого, удаление и перестановку.

In-memory реализация предназначена для domain/failure tests.
`PostgresAuditLog` используется production-like runtime: advisory lock назначает
глобальный sequence, каждая запись связывается SHA-256 hash предыдущей, а
database trigger и grants запрещают UPDATE/DELETE. Retention по умолчанию — семь
лет; WORM replica остаётся отдельной эксплуатационной задачей.

Audit details используют allow-list и не содержат API keys, токены и секреты.

## Operational log events

`audit.record.appended` сообщает sequence новой записи без её details;
`audit.integrity.failed` — несовпадение chain/hash. Эти operational events не
заменяют саму append-only запись и не меняют её retention.
