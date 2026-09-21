/**
 * Файл описывает application-level команды и порт между Gateway и trading core.
 *
 * Эти типы уже очищены от HTTP-specific деталей: user берётся из principal,
 * decimal values остаются строками, а controller передаёт команду только через
 * `TradingCommandPort`. Внутренние order book, ledger postings и settlement
 * здесь не представлены намеренно.
 */
/** Сторона заявки во внешнем command API. */
export type GatewaySide = 'BUY' | 'SELL';
/** Тип заявки во внешнем command API. */
export type GatewayOrderType = 'LIMIT' | 'MARKET';
/** Политика исполнения заявки во внешнем command API. */
export type GatewayTimeInForce = 'GTC' | 'IOC' | 'FOK';

/**
 * Стабильный DI-токен application boundary отправки trading-команд.
 *
 * HTTP controller внедряет этот Symbol вместо строкового имени и concrete core.
 * В component profile token связан с reference adapter; durable runtime должен
 * связать его с command journal/sequencer adapter.
 */
export const TRADING_COMMAND_PORT = Symbol('TRADING_COMMAND_PORT');

/**
 * Команда размещения после authentication, DTO validation и object authorization.
 *
 * Gateway сохраняет decimal values строками и добавляет `userId` из principal,
 * поэтому внешний клиент не может подменить владельца заявки перед trading core.
 */
export type GatewayPlaceOrderCommand = Readonly<{
  commandId: string;
  idempotencyKey: string;
  userId: string;
  accountId: string;
  instrumentId: string;
  clientOrderId: string;
  side: GatewaySide;
  orderType: GatewayOrderType;
  quantity: string;
  limitPrice: string | null;
  timeInForce: GatewayTimeInForce;
}>;

/** Команда отмены после проверки API key, владельца объекта и idempotency header. */
export type GatewayCancelOrderCommand = Readonly<{
  commandId: string;
  idempotencyKey: string;
  userId: string;
  accountId: string;
  instrumentId: string;
  orderId: string;
}>;

/**
 * Application port между HTTP Gateway и trading core.
 *
 * Controller зависит только от этого интерфейса: implementation может направлять
 * команды в sequencer, broker или reference core без deep import domain-модулей.
 * `listOrders` возвращает bounded page и opaque cursor для query boundary.
 */
export interface TradingCommandPort {
  /** Передаёт проверенную команду размещения в trading core. */
  placeOrder(command: GatewayPlaceOrderCommand): Promise<GatewayCommandResult>;
  /** Передаёт проверенную команду отмены в trading core. */
  cancelOrder(command: GatewayCancelOrderCommand): Promise<GatewayCommandResult>;
  /** Возвращает одну заявку по публичному orderId с owner isolation. */
  getOrder(userId: string, orderId: string): Promise<GatewayCommandResult | null>;
  /** Возвращает bounded page заявок для query API. */
  listOrders(
    userId: string,
    limit: number,
    cursor?: string,
  ): Promise<Readonly<{ items: readonly GatewayCommandResult[]; nextCursor: string | null }>>;
}

/** Безопасный внешний результат без ledger, order book и других внутренних объектов. */
export type GatewayCommandResult = Readonly<{
  commandId: string;
  orderId: string;
  status: 'ACCEPTED' | 'CANCEL_ACCEPTED';
}>;

/**
 * Reference trading core для API e2e и локального запуска без брокера.
 *
 * Реализация не выполняет matching: она демонстрирует границу admission и
 * сохраняет принятые команды в памяти. Production заменяет её адаптером
 * sequencer, сохраняя тот же `TradingCommandPort`.
 */
export class InMemoryTradingCommandPort implements TradingCommandPort {
  private readonly orders = new Map<
    string,
    Readonly<{ ownerId: string; result: GatewayCommandResult }>
  >();

  /** Принимает заявку после прохождения gateway admission и возвращает safe result. */
  async placeOrder(command: GatewayPlaceOrderCommand): Promise<GatewayCommandResult> {
    await Promise.resolve();
    const result = {
      commandId: command.commandId,
      orderId: command.clientOrderId,
      status: 'ACCEPTED',
    } as const;
    this.orders.set(command.clientOrderId, { ownerId: command.userId, result });
    return result;
  }

  /** Принимает отмену заявки и сохраняет её результат для query page. */
  async cancelOrder(command: GatewayCancelOrderCommand): Promise<GatewayCommandResult> {
    await Promise.resolve();
    const result = {
      commandId: command.commandId,
      orderId: command.orderId,
      status: 'CANCEL_ACCEPTED',
    } as const;
    this.orders.set(command.orderId, { ownerId: command.userId, result });
    return result;
  }

  /** Возвращает одну заявку владельца без раскрытия чужих order IDs. */
  async getOrder(userId: string, orderId: string): Promise<GatewayCommandResult | null> {
    await Promise.resolve();
    const stored = this.orders.get(orderId);
    if (!stored || stored.ownerId !== userId) return null;
    return stored.result;
  }

  /** Возвращает страницу принятых заявок с opaque cursor. */
  async listOrders(
    userId: string,
    limit: number,
    cursor?: string,
  ): Promise<Readonly<{ items: readonly GatewayCommandResult[]; nextCursor: string | null }>> {
    await Promise.resolve();
    const all = [...this.orders.values()]
      .filter(({ ownerId }) => ownerId === userId)
      .map(({ result }) => result);
    const start = cursor ? Number(cursor) : 0;
    const items = all.slice(start, start + limit);
    const nextCursor = start + items.length < all.length ? String(start + items.length) : null;
    return { items, nextCursor };
  }
}
