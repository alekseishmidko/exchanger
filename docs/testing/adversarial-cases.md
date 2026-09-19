# Adversarial и нестандартные входы

## Назначение

Adversarial suite проверяет не «успешный путь», а устойчивость transport,
contract и projection boundaries к неоднозначным, повреждённым и намеренно
враждебным входам. Тесты должны завершаться документированным `4xx` или protocol
error, но не `500`, uncaught exception, process crash, утечкой API key или
изменением business state.

## Запуск

```bash
pnpm adversarial:check
```

Набор использует фиксированные seeds:

- `18001` — property checks command/event contracts;
- `18002` — REST JSON fuzzing;
- `18003` — WebSocket protocol fuzzing.

Если property/fuzz failure найден, минимальный payload сохраняется как
regression fixture в `tests/fixtures/adversarial/` или прямо в соответствующий
spec, а seed добавляется в описание теста.

## Каталог входов

| Класс                          | Boundary                  | Ожидаемый outcome                                       |
| ------------------------------ | ------------------------- | ------------------------------------------------------- |
| empty/truncated/malformed JSON | REST parser               | `400`, без stack trace и секретов                       |
| oversized JSON                 | Fastify body limit        | `413` или другой `4xx`, без попадания в command port    |
| deeply nested JSON             | DTO validation            | `400 REQUEST_MALFORMED`                                 |
| duplicate JSON keys            | parser + DTO validation   | итоговое parsed значение валидируется allow-list схемой |
| Unicode-confusable identifiers | contracts/gateway         | `REQUEST_MALFORMED`, ASCII allow-list                   |
| control characters             | contracts/gateway         | `REQUEST_MALFORMED`, нет попадания в audit/idempotency  |
| decimal exponent/NaN/Infinity  | contracts/gateway/Decimal | reject до domain arithmetic                             |
| leading zero decimal           | contracts/gateway/Decimal | reject как неоднозначный формат                         |
| rounding boundary              | Decimal value object      | deterministic half-up result                            |
| timezone/DST timestamp         | contracts                 | только ISO timestamp с offset                           |
| stale/tampered cursor          | projections               | `PAGINATION_INVALID`/`BadRequestException`              |
| REST/WebSocket fuzz payload    | transport                 | bounded `4xx`/protocol error, socket/process живы       |
| unknown message type/version   | contracts                 | reject по compatibility policy                          |
| concurrent duplicate command   | idempotency               | один business effect, оба retry получают один result    |
| reused idempotency key         | idempotency               | `409 IDEMPOTENCY_KEY_REUSED`                            |
| freeze/pause during place      | admission                 | stable `409` rejection до durable acceptance            |
| cancel retry during match flow | gateway/trading port      | один cancel effect, повтор получает прежний result      |
| WebSocket subscription churn   | market-data               | ack/error sequence `0`, socket остаётся живым           |
| large sequence values          | market-data               | resync/snapshot без wrap и без process crash            |
| rate-limit abuse               | gateway                   | `429 RATE_LIMIT_EXCEEDED`, секреты не возвращаются      |

## Regression policy

Найденный payload не удаляется после исправления. Он остаётся regression case с
комментарием, какой invariant защищает: idempotency, ordering, isolation,
money precision, pagination или protocol stability.

## Automation policy

`pnpm adversarial:check` запускается в основном CI. Scheduled chaos/load jobs
остаются отдельными workflow, потому что требуют Docker и больше времени.
Nightly adversarial расширяется только bounded наборами: каждый fuzz/property
runner обязан иметь seed, timeout, owner и retention для минимального fixture.

Flaky race test нельзя отключать без issue, owner и срока исправления. Если
нестабильность вызвана реальным race, regression fixture переносится в
`tests/fixtures/adversarial/` или фиксируется прямо в spec до исправления.
