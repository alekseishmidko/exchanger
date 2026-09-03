# ADR 0003: log-first для settlement

## Статус

Принято для этапа 7.

## Контекст

После match торговая сделка должна быть воспроизводима: событие `TradeExecuted`, проводки ledger и результат `SettlementApplied` должны связываться одним `tradeId`. Повторная доставка не должна создавать второй бизнес-эффект.

## Решение

Вводится append-only event-log adapter с consumer offset, повторными попытками и dead-letter queue. Settlement обрабатывает `TradeExecuted` идемпотентно через запись операции в ledger, а `SettlementApplied` публикуется после завершения проводок.

На production границе adapter должен быть заменён на durable журнал или outbox с атомарной фиксацией вместе с транзакцией ledger. Текущая реализация является in-memory reference adapter для контрактных и failure-тестов.

## Последствия

- replay и reconciliation используют неизменяемые события и `tradeId`;
- timeout и временный сбой обрабатываются retry;
- poison-событие переводится в DLQ и требует ручного runbook-разбора;
- журнал и audit records требуют retention policy и отдельного storage lifecycle.
