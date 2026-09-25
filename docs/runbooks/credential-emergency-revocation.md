# Emergency credential revocation

## Назначение

Runbook применяется при компрометации API key, human session, password pepper
или Redis token-key material. Не копируйте credential, email, IP или connection
string в incident channel, ticket, shell history либо команды диагностики.

## API key

1. Использовать отдельный admin credential и выполнить revoke по `keyId` с новым
   `Idempotency-Key` и reason code `credential_compromise`.
2. Проверить 401 старого key через обе backend replicas и закрытие private
   WebSocket не позднее `WEBSOCKET_AUTH_RECHECK_MS + 1s`.
3. Если PostgreSQL недоступен, закрыть ingress для machine traffic. Не включать
   локальный cache или fail-open fallback.
4. После восстановления PostgreSQL повторить ту же idempotency command, проверить
   audit chain и только затем выпустить replacement key.

## Human sessions и Redis outage

1. При доступном Redis вызвать point revoke или revoke-all. Password compromise
   дополнительно требует password reset/securityVersion increment.
2. При недоступном Redis readiness должна оставаться 503, liveness — 200; ingress
   прекращает auth admission. Memory fallback запрещён.
3. После восстановления выполнить login canary, revoke его с другой replica и
   доказать, что stale touch возвращает отказ.

## Pepper/token-key rotation

Password hashes содержат pepper version. Сначала добавить новый secret в
`AUTH_PASSWORD_PEPPER_SET`, развернуть readers, затем переключить
`AUTH_PASSWORD_PEPPER_VERSION`; старую версию удалять только после rehash/retention
окна. `AUTH_TOKEN_HASH_SECRET` одновременно защищает session lookup/Redis keys:
его emergency rotation намеренно инвалидирует существующие sessions. Плановая
rotation требует отдельной dual-read migration и не выполняется простой заменой env.

## WebSocket cleanup и завершение

Проверить отсутствие sockets с отозванным key, bounded event
`websocket.rejected`, readiness всех replicas и audit action. В отчёт записывать
только `keyId`, command/correlation IDs и timestamps. Raw secret запрещён.
