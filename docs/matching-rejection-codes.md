# Matching engine rejection codes

| Code                       | Значение                                                                |
| -------------------------- | ----------------------------------------------------------------------- |
| `INVALID_ORDER`            | пустой ID/user, нулевое или отрицательное quantity, duplicate active ID |
| `LIMIT_PRICE_REQUIRED`     | limit order без price                                                   |
| `MARKET_PRICE_NOT_ALLOWED` | market order с заданной price                                           |
| `SELF_TRADE`               | incoming order пересекает order того же user                            |
| `FOK_NOT_FILLED`           | нет полной доступной ликвидности                                        |
| `ORDER_NOT_FOUND`          | cancel неизвестного или уже исполненного order                          |
| `ORDER_NOT_ACTIVE`         | зарезервированный код для будущего cancel state                         |
