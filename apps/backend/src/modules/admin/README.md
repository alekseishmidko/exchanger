# Admin и risk

## Назначение и границы

`AdminService` является единственной write boundary для изменения торговых
инструментов, fee/risk policies, freeze state и circuit breaker. Сервис не
принимает actor из пользовательского payload: adapter обязан передать
`AuditActor`, полученный из проверенной служебной identity.

Каждая команда имеет стабильный `commandId`. Повтор команды возвращает прежний
`AdminResult` и не создаёт второй эффект. Критические изменения проходят dual
control: инициатор получает `PENDING_APPROVAL`, а применение выполняется только
после `approve` другим уполномоченным actor.

## Operational state

- `FREEZE_USER` блокирует все accounts пользователя;
- `FREEZE_ACCOUNT` блокирует один account;
- `EMERGENCY_STOP` с target `*` запрещает admission глобально;
- instrument target запрещает admission только для указанного инструмента;
- fee/risk policies неизменяемы и выбираются по `effectiveAt`;
- policy rollback оформляется новой версией, а не изменением истории.

## Compensation

Исходная команда и audit records никогда не удаляются. Freeze/emergency stop
обращаются отдельной compensation command, содержащей ссылку на исходный
`commandId`. Configuration и policy changes компенсируются новой версией через
обычный dual-control flow.

Публичные типы и методы сопровождаются подробными русскими JSDoc-комментариями.

## REST API и роли

Admin transport boundary опубликован под `/api/v1/admin` и содержит отдельные
write endpoints для instruments, fee/risk policies, freeze state, circuit
breaker и approval, а также read-only reconciliation status. Actor всегда
строится из API-key principal и не принимается из body.

Поддерживаются роли `admin`, `risk_manager`, `auditor`, `support`. Они
преобразуются в `ADMIN`, `RISK_MANAGER`, `AUDITOR`, `SUPPORT` без повышения
привилегий, после чего `AdminService` применяет детальную role matrix. Критические
операции возвращают `PENDING_APPROVAL`; второй actor подтверждает их через
`POST /api/v1/admin/approvals/{commandId}`.

Все административные write-запросы используют strict DTO,
`Idempotency-Key`, rate limit и tamper-evident audit log. Ошибка domain policy
преобразуется в безопасный код без stack trace и внутренних aggregate данных.

Полный реестр transport operations, ownership и безопасные DTO examples:
[`docs/api-client-guide.md`](../../../../../docs/api-client-guide.md) и
[`docs/openapi/application.yaml`](../../../../../docs/openapi/application.yaml).

## Operational log events

`admin.action.applied` фиксирует единственное фактическое применение команды;
`admin.action.rejected` — отказ role policy. Повтор по command ID не создаёт
второй success. Immutable audit chain остаётся отдельным бизнес-контрактом.
