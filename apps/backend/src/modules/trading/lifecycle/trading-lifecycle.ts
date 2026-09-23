/**
 * Единый каталог статусов и кодов отказа trading runtime.
 *
 * Этот файл является source of truth для REST, WebSocket, projections, audit и
 * durable storage. Новые статусы нельзя добавлять локально в DTO/controller:
 * сначала расширяется этот контракт, затем обновляются transition table,
 * OpenAPI/AsyncAPI и projection mapping.
 */

/**
 * Жизненный цикл durable command journal.
 *
 * Пример: HTTP controller вернул клиенту `ACCEPTED`, но processor ещё не
 * выполнил matching. В journal команда уже прошла `RECEIVED -> ACCEPTED`, а
 * публичный `executionStatus` остаётся `PENDING`. Это не даёт UI принять
 * durable запись команды за завершённую сделку.
 */
export const COMMAND_LIFECYCLE_STATUSES = [
  'RECEIVED',
  'ACCEPTED',
  'PROCESSING',
  'APPLIED',
  'REJECTED',
  'RECOVERY_REQUIRED',
] as const;

/** Статус durable command journal, который хранится в БД и audit trail. */
export type CommandLifecycleStatus = (typeof COMMAND_LIFECYCLE_STATUSES)[number];

/**
 * Состояние фактического исполнения команды, видимое публичному клиенту.
 *
 * `PENDING` означает: команда долговечно принята, но business effect ещё не
 * подтверждён. `APPLIED` ставится только после применения domain operation,
 * например после settlement ledger commit для сделки.
 */
export const COMMAND_EXECUTION_STATUSES = [
  'PENDING',
  'APPLIED',
  'REJECTED',
  'RECOVERY_REQUIRED',
] as const;

/** Публичный execution status отделён от факта durable acceptance. */
export type CommandExecutionStatus = (typeof COMMAND_EXECUTION_STATUSES)[number];

/**
 * Жизненный цикл заявки в trading runtime.
 *
 * Статусы описывают именно order state, а не command journal. Например cancel
 * command может быть `ACCEPTED/PENDING`, пока заявка находится в
 * `CANCEL_PENDING`; terminal `FILLED`, `CANCELLED` и `REJECTED` не должны
 * возвращаться в активные состояния.
 */
export const ORDER_LIFECYCLE_STATUSES = [
  'PENDING',
  'OPEN',
  'PARTIALLY_FILLED',
  'FILLED',
  'CANCEL_PENDING',
  'CANCELLED',
  'REJECTED',
] as const;

/** Статус заявки, единый для matching, projections и market/user stream. */
export type OrderLifecycleStatus = (typeof ORDER_LIFECYCLE_STATUSES)[number];

/**
 * Единые коды отказа command/order path.
 *
 * Каталог используется как публичный контракт: REST errors, private
 * WebSocket events, projections, audit и OpenAPI/AsyncAPI должны ссылаться на
 * эти же значения. В кодах нет деталей инфраструктуры, stack trace,
 * SQLSTATE, API keys или финансовых payload.
 */
export const TRADING_REJECTION_CODES = [
  'COMMAND_ID_REUSED',
  'IDEMPOTENCY_KEY_REUSED',
  'IDEMPOTENCY_OPERATION_PENDING',
  'INSTRUMENT_PAUSED',
  'INSTRUMENT_RULES_MISSING',
  'INVALID_QUANTITY',
  'INVALID_PRICE',
  'LIMIT_PRICE_REQUIRED',
  'MARKET_PRICE_NOT_ALLOWED',
  'OPEN_ORDER_LIMIT',
  'NOTIONAL_LIMIT',
  'INSUFFICIENT_BALANCE',
  'ORDER_REJECTED',
  'ORDER_CANCEL_REJECTED',
  'ORDER_NOT_FOUND',
  'ORDER_NOT_ACTIVE',
  'SELF_TRADE',
  'FOK_NOT_FILLED',
  'RISK_REJECTED',
  'RECOVERY_REQUIRED',
] as const;

/** Safe rejection code без exception details и stack trace. */
export type TradingRejectionCode = (typeof TRADING_REJECTION_CODES)[number];

/**
 * Формальная таблица допустимых переходов command lifecycle.
 *
 * Таблица намеренно монотонная: terminal состояния не имеют исходящих
 * переходов, а `RECOVERY_REQUIRED` может вернуться только в recovery replay
 * path. Любое изменение этой таблицы требует обновления миграции, тестов и
 * `docs/trading-lifecycle.md`.
 */
export const COMMAND_TRANSITIONS: Readonly<
  Record<CommandLifecycleStatus, readonly CommandLifecycleStatus[]>
> = {
  RECEIVED: ['ACCEPTED', 'REJECTED', 'RECOVERY_REQUIRED'],
  ACCEPTED: ['PROCESSING', 'REJECTED', 'RECOVERY_REQUIRED'],
  PROCESSING: ['APPLIED', 'REJECTED', 'RECOVERY_REQUIRED'],
  APPLIED: [],
  REJECTED: [],
  RECOVERY_REQUIRED: ['PROCESSING', 'APPLIED', 'REJECTED'],
};

/**
 * Формальная таблица допустимых переходов order lifecycle.
 *
 * Она защищает от “воскрешения” заявки: cancel не может открыть `FILLED` или
 * повторно закрыть `CANCELLED`. Matching/settlement/projections должны
 * использовать эти переходы как общий язык статусов.
 */
export const ORDER_TRANSITIONS: Readonly<
  Record<OrderLifecycleStatus, readonly OrderLifecycleStatus[]>
> = {
  PENDING: ['OPEN', 'PARTIALLY_FILLED', 'FILLED', 'REJECTED', 'CANCEL_PENDING'],
  OPEN: ['PARTIALLY_FILLED', 'FILLED', 'CANCEL_PENDING', 'CANCELLED', 'REJECTED'],
  PARTIALLY_FILLED: ['FILLED', 'CANCEL_PENDING', 'CANCELLED'],
  FILLED: [],
  CANCEL_PENDING: ['CANCELLED', 'REJECTED'],
  CANCELLED: [],
  REJECTED: [],
};

/**
 * Проверяет monotonic command transition.
 *
 * @example
 * ```ts
 * assertCommandTransition('ACCEPTED', 'PROCESSING'); // ok
 * assertCommandTransition('APPLIED', 'PROCESSING'); // throw
 * ```
 */
export function assertCommandTransition(
  from: CommandLifecycleStatus,
  to: CommandLifecycleStatus,
): void {
  if (from === to) return;
  if (!COMMAND_TRANSITIONS[from].includes(to)) {
    throw new Error(`Invalid command transition: ${from} -> ${to}`);
  }
}

/**
 * Проверяет monotonic order transition и terminal protection.
 *
 * @example
 * ```ts
 * assertOrderTransition('OPEN', 'CANCEL_PENDING'); // ok
 * assertOrderTransition('FILLED', 'CANCEL_PENDING'); // throw
 * ```
 */
export function assertOrderTransition(from: OrderLifecycleStatus, to: OrderLifecycleStatus): void {
  if (from === to) return;
  if (!ORDER_TRANSITIONS[from].includes(to)) {
    throw new Error(`Invalid order transition: ${from} -> ${to}`);
  }
}
