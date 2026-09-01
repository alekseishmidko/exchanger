# Matching engine

## Назначение

Чистый deterministic matching engine для одного инструмента. Он хранит bids/asks price levels, FIFO queue внутри уровня, active orders, статус/остаток заявки и sequence последней команды.

## Правила исполнения

- price-time priority: лучшая цена выбирается первой, внутри цены — меньший sequence;
- trade price всегда равна passive maker price;
- limit пересекает только допустимые противоположные уровни;
- market берёт доступную ликвидность без собственной цены;
- GTC добавляет остаток в книгу, IOC отменяет остаток, FOK отклоняется без частичного исполнения;
- cancel удаляет только active order;
- self-trade prevention отклоняет incoming order;
- engine не обращается к сети, БД или системным часам.

## Состояние и события

`ORDER_ACCEPTED`, `TRADE_EXECUTED`, `ORDER_UPDATED`, `ORDER_CANCELLED` и `ORDER_REJECTED` возвращаются в стабильном порядке. Каждая команда увеличивает sequence на единицу; replay одинакового массива команд создаёт одинаковые события и book state.

Полная таблица переходов и диаграмма находятся в [`docs/matching-engine.md`](../../../../docs/matching-engine.md), rejection codes — в `docs/matching-rejection-codes.md`.
