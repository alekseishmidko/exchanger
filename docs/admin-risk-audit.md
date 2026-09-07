# Admin, risk и audit

Статус: accepted. Дата: 2026-09-07.

## Permission matrix

| Action | ADMIN | RISK_MANAGER | AUDITOR | SUPPORT | Dual control |
| --- | --- | --- | --- | --- | --- |
| Instrument configuration | allow | allow | deny | deny | required |
| Fee policy change | allow | allow | deny | deny | required |
| Risk policy change | deny | allow | deny | deny | required |
| User/account freeze | allow | allow | deny | deny | no |
| Emergency stop/resume | allow | deny | deny | deny | required |
| Reconciliation dashboard | allow | deny | allow | deny | no |

Запрещённая попытка получает `ADMIN_FORBIDDEN` и фиксируется как
`ACTION_REJECTED` с реальным actor, command ID и target.

## Audit field catalog

| Field | Назначение |
| --- | --- |
| `id`, `sequence` | уникальность и порядок append-only chain |
| `occurredAt` | UTC timestamp действия |
| `actor.actorId`, `actor.role` | проверенный субъект и роль на момент действия |
| `eventType`, `actionType` | этап и категория административного действия |
| `commandId`, `targetId` | идемпотентность и затронутый объект |
| `details` | allow-listed metadata без секретов |
| `previousHash`, `hash` | tamper detection |

Жизненный цикл критичной команды: `ACTION_REQUESTED` → `ACTION_APPROVED` →
`ACTION_APPLIED`. Компенсация создаёт `COMPENSATION_APPLIED` и ссылается на
исходный command ID; исходные записи остаются неизменными.

## Risk policy and limits

Risk policy содержит положительный `maxOrderNotional`, целочисленный
`maxOpenOrders`, уникальную `version` и монотонный `effectiveAt`. Fee policy
содержит неотрицательные maker/taker rates. Trading admission обязан сначала
проверить global/instrument circuit breaker, затем user/account freeze, после
этого immutable policy version, действующую на время команды.

## Reconciliation dashboard

Dashboard показывает integrity audit chain, pending approvals, frozen users и
accounts, остановленные targets, instrument statuses и активные policy versions.
Каждое чтение dashboard само фиксируется событием `RECONCILIATION_EXECUTED`.

## Retention policy

Audit records хранятся не меньше нормативного срока финансового аудита и дольше
связанных command/event records. Удаление отдельных записей запрещено. Архив
должен сохранять sequence/hash chain, быть зашифрован и защищён object lock.
Проверка integrity выполняется периодически и после каждого restore.
