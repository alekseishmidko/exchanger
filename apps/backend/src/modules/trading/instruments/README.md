# Instruments module

## Назначение

Каталог торговых инструментов и immutable trading rules. Модуль проверяет заявку до передачи в matching engine и возвращает версию правил, относительно которой она была принята.

## Публичный контракт

- `Instrument` — base/quote pair, lifecycle и история версий правил;
- `InstrumentRules` — tick/lot sizes, quantity bounds, price band, fee policy и trading limits;
- `validateOrder` — проверка precision, lifecycle, price/quantity limits и notional;
- `TradingRuleViolation` — безопасный код причины отказа.

## Инварианты

- base и quote assets различаются;
- tick size, lot size и limits строго положительны;
- min quantity не превосходит max quantity;
- rules versions имеют монотонный `effectiveAt`;
- PAUSED instrument не принимает новые заявки;
- limit price кратна tick size и находится в price band;
- quantity кратна lot size и находится в разрешённых bounds;
- результат содержит rules version, действовавшую на момент проверки.

## Audit и admin changes

Изменение status или добавление rules version является административным действием и должно записываться в audit log вместе с actor, instrument ID, old/new status, rules version, effectiveAt, correlation ID и причиной. Старые версии не изменяются и не удаляются.

Подробный каталог полей, lifecycle diagram и policy размещены в [`docs/instrument-rules.md`](../../../../docs/instrument-rules.md).
