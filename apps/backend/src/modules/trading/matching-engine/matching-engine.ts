import { Decimal } from '../../shared-kernel';
import {
  LOG_EVENTS,
  NOOP_OPERATIONAL_LOGGER,
  NOOP_TELEMETRY,
  NOOP_OPERATIONAL_METRICS,
  OperationalMetrics,
  OperationalLogger,
  TelemetryPort,
  TRACE_SPANS,
} from '../../observability';

/** Направление заявки в стакане. */
export type MatchingSide = 'BUY' | 'SELL';
/** Тип заявки matching engine. */
export type MatchingOrderType = 'LIMIT' | 'MARKET';
/** Политика исполнения остатка заявки. */
export type MatchingTimeInForce = 'GTC' | 'IOC' | 'FOK';
/** Lifecycle-состояние заявки внутри engine. */
export type OrderStatus = 'OPEN' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELLED';

/** Команда размещения заявки в одном instrument book. */
export type PlaceOrder = Readonly<{
  type: 'PLACE';
  orderId: string;
  userId: string;
  side: MatchingSide;
  orderType: MatchingOrderType;
  quantity: Decimal;
  price?: Decimal;
  timeInForce: MatchingTimeInForce;
}>;

/** Команда отмены active order. */
export type CancelOrder = Readonly<{ type: 'CANCEL'; orderId: string }>;
/** Команда matching engine. */
export type MatchingCommand = PlaceOrder | CancelOrder;

/** Безопасные коды отказов matching engine. */
export type RejectionCode =
  | 'INVALID_ORDER'
  | 'LIMIT_PRICE_REQUIRED'
  | 'MARKET_PRICE_NOT_ALLOWED'
  | 'SELF_TRADE'
  | 'FOK_NOT_FILLED'
  | 'ORDER_NOT_FOUND'
  | 'ORDER_NOT_ACTIVE';

/** Общее поле deterministic engine event. */
type EventBase = Readonly<{ sequence: number; orderId: string }>;
/** Результат принятия или изменения состояния заявки. */
export type OrderEvent = EventBase &
  Readonly<{
    kind: 'ORDER_ACCEPTED' | 'ORDER_UPDATED' | 'ORDER_CANCELLED';
    status: OrderStatus;
    remainingQuantity: string;
  }>;
/** Результат исполненной сделки. */
export type TradeEvent = EventBase &
  Readonly<{
    kind: 'TRADE_EXECUTED';
    makerOrderId: string;
    takerOrderId: string;
    makerUserId: string;
    takerUserId: string;
    price: string;
    quantity: string;
  }>;
/** Результат отклонённой команды. */
export type RejectionEvent = EventBase &
  Readonly<{
    kind: 'ORDER_REJECTED';
    code: RejectionCode;
  }>;
/** Доменное событие matching engine. */
export type MatchingEvent = OrderEvent | TradeEvent | RejectionEvent;

type ActiveOrder = {
  readonly orderId: string;
  readonly userId: string;
  readonly side: MatchingSide;
  readonly orderType: MatchingOrderType;
  readonly price?: Decimal;
  readonly sequence: number;
  remainingQuantity: Decimal;
  status: OrderStatus;
  readonly timeInForce: MatchingTimeInForce;
};

/** Deterministic price-time priority matching engine для одного инструмента. */
export class MatchingEngine {
  private sequence = 0;
  private readonly activeOrders = new Map<string, ActiveOrder>();
  private readonly bids = new Map<string, ActiveOrder[]>();
  private readonly asks = new Map<string, ActiveOrder[]>();

  /**
   * Создаёт движок с observability ports, не связывая домен с NestJS SDK.
   *
   * No-op adapters используются в replay/property/benchmark тестах. Production
   * adapters открывают один span и пишут итоговые события на command boundary;
   * внутри перебора price levels сетевой или дисковый I/O не выполняется.
   *
   * @param logger Каталогизированные terminal operational events.
   * @param telemetry Port одного span на команду matching engine.
   * @param metrics Счётчик исполненных сделок с bounded labels.
   */
  constructor(
    private readonly logger: OperationalLogger = NOOP_OPERATIONAL_LOGGER,
    private readonly telemetry: TelemetryPort = NOOP_TELEMETRY,
    private readonly metrics: OperationalMetrics = NOOP_OPERATIONAL_METRICS,
  ) {}

  /**
   * Применяет одну команду и логирует только terminal result, не циклы matching.
   * Это сохраняет наблюдаемость order boundary без I/O на каждой итерации уровня.
   *
   * @param command Команда размещения либо отмены для текущего instrument book.
   * @returns Детерминированная последовательность domain events.
   */
  apply(command: MatchingCommand): readonly MatchingEvent[] {
    return this.telemetry.span(TRACE_SPANS.MATCHING_APPLY, { 'command.type': command.type }, () =>
      this.applyObserved(command),
    );
  }

  /** Исполняет deterministic matching внутри уже открытого tracing span. */
  private applyObserved(command: MatchingCommand): readonly MatchingEvent[] {
    this.sequence += 1;
    const events = command.type === 'PLACE' ? this.place(command) : this.cancel(command);
    for (const event of events) {
      if (event.kind === 'TRADE_EXECUTED') this.metrics.observeTrade('other', 'executed');
    }
    const rejection = events.find((event) => event.kind === 'ORDER_REJECTED');
    if (rejection?.kind === 'ORDER_REJECTED') {
      this.logger.warn('matching', LOG_EVENTS.MATCHING_ORDER_REJECTED, {
        metadata: { orderId: command.orderId, rejectionCode: rejection.code },
      });
    } else {
      this.logger.info('matching', LOG_EVENTS.MATCHING_ORDER_PROCESSED, {
        metadata: { orderId: command.orderId, emittedEvents: events.length },
      });
    }
    return events;
  }

  /** Возвращает sequence последней применённой команды. */
  getLastSequence(): number {
    return this.sequence;
  }

  /** Возвращает active order snapshot для cancel/query adapters. */
  getActiveOrders(): readonly Readonly<ActiveOrder>[] {
    return [...this.activeOrders.values()].map((order) => ({ ...order }));
  }

  private place(command: PlaceOrder): readonly MatchingEvent[] {
    const base = { sequence: this.sequence, orderId: command.orderId };
    if (
      command.orderId.trim() === '' ||
      command.userId.trim() === '' ||
      command.quantity.isNegative() ||
      command.quantity.isZero()
    ) {
      return [{ ...base, kind: 'ORDER_REJECTED', code: 'INVALID_ORDER' }];
    }
    if (this.activeOrders.has(command.orderId)) {
      return [{ ...base, kind: 'ORDER_REJECTED', code: 'INVALID_ORDER' }];
    }
    if (command.orderType === 'LIMIT' && !command.price) {
      return [{ ...base, kind: 'ORDER_REJECTED', code: 'LIMIT_PRICE_REQUIRED' }];
    }
    if (command.orderType === 'MARKET' && command.price) {
      return [{ ...base, kind: 'ORDER_REJECTED', code: 'MARKET_PRICE_NOT_ALLOWED' }];
    }
    const order: ActiveOrder = {
      orderId: command.orderId,
      userId: command.userId,
      side: command.side,
      orderType: command.orderType,
      ...(command.price ? { price: command.price } : {}),
      sequence: this.sequence,
      remainingQuantity: command.quantity,
      status: 'OPEN',
      timeInForce: command.timeInForce,
    };
    if (command.timeInForce === 'FOK' && !this.canFillFully(order)) {
      return [{ ...base, kind: 'ORDER_REJECTED', code: 'FOK_NOT_FILLED' }];
    }
    const events: MatchingEvent[] = [];
    while (!order.remainingQuantity.isZero()) {
      const maker = this.bestMatch(order);
      if (!maker) break;
      if (maker.userId === order.userId) {
        return [...events, { ...base, kind: 'ORDER_REJECTED', code: 'SELF_TRADE' }];
      }
      const quantity =
        order.remainingQuantity.compare(maker.remainingQuantity) < 0
          ? order.remainingQuantity
          : maker.remainingQuantity;
      order.remainingQuantity = order.remainingQuantity.subtract(quantity);
      maker.remainingQuantity = maker.remainingQuantity.subtract(quantity);
      maker.status = maker.remainingQuantity.isZero() ? 'FILLED' : 'PARTIALLY_FILLED';
      order.status = order.remainingQuantity.isZero() ? 'FILLED' : 'PARTIALLY_FILLED';
      events.push({
        ...base,
        kind: 'TRADE_EXECUTED',
        makerOrderId: maker.orderId,
        takerOrderId: order.orderId,
        makerUserId: maker.userId,
        takerUserId: order.userId,
        price: maker.price?.toString() ?? '0',
        quantity: quantity.toString(),
      });
      if (maker.remainingQuantity.isZero()) this.remove(maker);
    }
    events.unshift({
      ...base,
      kind: 'ORDER_ACCEPTED',
      status: order.status,
      remainingQuantity: order.remainingQuantity.toString(),
    });
    if (!order.remainingQuantity.isZero()) {
      if (order.timeInForce === 'GTC') {
        order.status = order.status === 'PARTIALLY_FILLED' ? 'PARTIALLY_FILLED' : 'OPEN';
        this.activeOrders.set(order.orderId, order);
        this.addToBook(order);
      } else {
        order.status = 'CANCELLED';
        events.push({
          ...base,
          kind: 'ORDER_CANCELLED',
          status: 'CANCELLED',
          remainingQuantity: order.remainingQuantity.toString(),
        });
      }
    }
    return events;
  }

  private cancel(command: CancelOrder): readonly MatchingEvent[] {
    const base = { sequence: this.sequence, orderId: command.orderId };
    const order = this.activeOrders.get(command.orderId);
    if (!order) return [{ ...base, kind: 'ORDER_REJECTED', code: 'ORDER_NOT_FOUND' }];
    this.remove(order);
    order.status = 'CANCELLED';
    return [
      {
        ...base,
        kind: 'ORDER_CANCELLED',
        status: 'CANCELLED',
        remainingQuantity: order.remainingQuantity.toString(),
      },
    ];
  }

  private canFillFully(order: ActiveOrder): boolean {
    let remaining = order.remainingQuantity;
    for (const maker of this.sortedOpposite(order)) {
      if (maker.userId === order.userId) return false;
      remaining =
        remaining.compare(maker.remainingQuantity) < 0
          ? Decimal.from('0')
          : remaining.subtract(maker.remainingQuantity);
      if (remaining.isZero()) return true;
    }
    return remaining.isZero();
  }

  private bestMatch(order: ActiveOrder): ActiveOrder | undefined {
    const candidates = this.sortedOpposite(order);
    const maker = candidates[0];
    if (!maker) return undefined;
    if (order.orderType === 'MARKET') return maker;
    if (!order.price || !maker.price) return undefined;
    return order.side === 'BUY'
      ? order.price.compare(maker.price) >= 0
        ? maker
        : undefined
      : order.price.compare(maker.price) <= 0
        ? maker
        : undefined;
  }

  private sortedOpposite(order: ActiveOrder): ActiveOrder[] {
    const levels = order.side === 'BUY' ? this.asks : this.bids;
    return [...levels.values()]
      .flat()
      .filter((maker) => {
        if (order.orderType === 'MARKET') return true;
        if (!order.price || !maker.price) return false;
        return order.side === 'BUY'
          ? order.price.compare(maker.price) >= 0
          : order.price.compare(maker.price) <= 0;
      })
      .sort((left, right) => {
        const priceOrder =
          order.side === 'BUY'
            ? left.price!.compare(right.price!)
            : right.price!.compare(left.price!);
        return priceOrder === 0 ? left.sequence - right.sequence : priceOrder;
      });
  }

  private addToBook(order: ActiveOrder): void {
    const book = order.side === 'BUY' ? this.bids : this.asks;
    const key = order.price!.toString();
    const level = book.get(key) ?? [];
    level.push(order);
    book.set(key, level);
  }

  private remove(order: ActiveOrder): void {
    this.activeOrders.delete(order.orderId);
    if (!order.price) return;
    const book = order.side === 'BUY' ? this.bids : this.asks;
    const key = order.price.toString();
    const level = book.get(key)?.filter(({ orderId }) => orderId !== order.orderId) ?? [];
    if (level.length === 0) book.delete(key);
    else book.set(key, level);
  }
}
