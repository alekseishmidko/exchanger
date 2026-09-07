# Stage 12: системная проверка

Статус: partially verified. Дата: 2026-09-08.

## Покрытый системный поток

`system.e2e-spec.ts` создаёт assets/accounts, зачисляет стартовые балансы,
резервирует средства BUY/SELL заявок, передаёт команды через trading state
machine в matching engine, применяет settlement, сверяет balanced ledger и строит
order/trade/balance projections. Затем event log архивируется и восстанавливается,
а matching commands replay-ятся в новый engine.

Повтор command ID возвращает прежние matching events. Повтор `TradeExecuted`
возвращает прежний `SettlementApplied`; количество ledger postings не меняется.

## Проверки recovery

- event archive защищён SHA-256 checksum;
- restore отклоняет изменённый архив;
- retention выполняется только после создания архива;
- Pilot recovery проверяет 10 000 событий с RPO=0;
- replay matching commands создаёт идентичные events.

## Неподтверждённые внешние gates

На машине проверки отсутствуют Docker, `pg_dump`, `pg_restore` и `psql`. Поэтому
PostgreSQL backup/restore и end-to-end infrastructure RTO/RPO не отмечены как
выполненные. Скрипт и процедура готовы, но должны быть запущены против отдельной
restore database.

Runbooks требуют ручного walkthrough и подписи ответственного инженера. Наличие
документа не считается человеческой проверкой.
