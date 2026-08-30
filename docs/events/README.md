# Каталог контрактных сообщений

Статус: accepted  
Дата: 2026-08-31

Все сообщения экспортируются из `@exchange/contracts` и проходят runtime validation через Zod. Неизвестные поля принимаются для обратной совместимости и удаляются при нормализации. Повторная доставка с тем же `messageId` допустима: consumer обязан обеспечить идемпотентный бизнес-эффект.

## Общий envelope

Каждое сообщение содержит `messageId`, `messageType`, положительный `messageVersion`, `occurredAt`, `receivedAt`, числовую строку `sequence`, `partitionKey`, `correlationId`, nullable `causationId` и `producer`.

## Команды

| Тип           | Producer | Consumers         | Payload                                                                       |
| ------------- | -------- | ----------------- | ----------------------------------------------------------------------------- |
| `PlaceOrder`  | gateway  | trading/sequencer | order, user/account, instrument, side, type, decimal quantity/price, policies |
| `CancelOrder` | gateway  | trading/sequencer | order, user/account и instrument identifiers                                  |

Команда выражает намерение и не подтверждает изменение состояния.

## События

| Тип                 | Producer        | Consumers                            | Payload                                          |
| ------------------- | --------------- | ------------------------------------ | ------------------------------------------------ |
| `OrderAccepted`     | trading         | gateway, projections, market-data    | order reference и decimal quantities             |
| `OrderRejected`     | trading/gateway | gateway, audit                       | order reference, safe reason code/message        |
| `OrderCancelled`    | trading         | gateway, projections, market-data    | order reference, remaining quantity, reason code |
| `TradeExecuted`     | matching-engine | settlement, projections, market-data | trade, orders, decimal price/quantity/fees       |
| `SettlementApplied` | settlement      | ledger, projections, audit           | trade и posting deltas                           |

Событие описывает уже совершившийся факт. Денежные значения, цены и количества всегда передаются decimal-строками без floating point.

## Compatibility policy

- старые версии сообщений должны продолжать валидироваться;
- добавление необязательного поля не требует breaking version;
- неизвестные поля игнорируются consumer-ом после schema parsing;
- изменение обязательного поля, типа или смысла требует новой версии, ADR и migration plan;
- duplicate delivery не отклоняется схемой, а обрабатывается idempotency policy consumer-а.
