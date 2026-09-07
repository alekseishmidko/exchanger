# Runbook: emergency stop и resume

Статус: accepted. Дата: 2026-09-07.

1. Инициатор с ролью `ADMIN` создаёт `EMERGENCY_STOP` для instrument ID или `*`.
2. Проверить причину, correlation IDs, открытые orders и состояние dependencies.
3. Второй независимый `ADMIN` подтверждает тот же command ID.
4. Убедиться, что `canAdmit` запрещает новые команды; принятые ранее команды
   обрабатываются по отдельно выбранной incident policy.
5. Сохранить dashboard и проверить audit integrity.
6. После устранения причины создать `RESUME_TRADING`; resume также требует dual control.
7. Проверить readiness, sequence gaps, projections и market-data resync.

Нельзя редактировать или удалять stop record. Ошибочный stop компенсируется
отдельной resume/compensation command.
