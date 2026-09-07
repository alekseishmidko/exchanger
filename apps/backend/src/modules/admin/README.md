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
