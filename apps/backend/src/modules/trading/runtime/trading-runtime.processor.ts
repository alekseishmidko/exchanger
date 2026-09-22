import { BadRequestException, ConflictException } from '@nestjs/common';
import type {
  GatewayCancelOrderCommand,
  GatewayCommandResult,
  GatewayPlaceOrderCommand,
  TradingCommandPort,
} from '../../gateway';
import { MarketDataHub } from '../../market-data';
import { LedgerPort } from '../../ledger';
import { ProjectionStore } from '../../projections';
import { Decimal, createId, type AccountId, type AssetId } from '../../shared-kernel';
import { InstrumentCatalogService, InstrumentSnapshot } from '../instruments';
import { MatchingEngine, MatchingEvent, MatchingCommand } from '../matching-engine/matching-engine';
import { SettlementService, TradeExecuted } from '../settlement';

/** Сохранённый application snapshot заявки, необходимый для settlement/release. */
type RuntimeOrderState = Readonly<{
  orderId: string;
  userId: string;
  accountId: AccountId;
  instrumentId: string;
  side: 'BUY' | 'SELL';
  baseAssetId: AssetId;
  quoteAssetId: AssetId;
  quantity: Decimal;
  price: Decimal;
}>;

/** Ошибка продуктового trading runtime со стабильным публичным кодом. */
export class TradingRuntimeRejection extends ConflictException {
  constructor(readonly rejectionCode: string) {
    super({ code: rejectionCode, message: 'Trading command was rejected' });
  }
}

/**
 * Связный application pipeline spot trading MVP.
 *
 * Processor не является HTTP controller-ом: он реализует тот же
 * `TradingCommandPort`, поэтому transport может заменить старый admission-only
 * adapter на runtime без доступа к matching engine, ledger или projections.
 * Команда проходит immutable rules validation, reserve-before-match, deterministic
 * matching, settlement, projection apply и market-data publication в одном
 * application flow.
 *
 * @example
 * ```ts
 * await runtime.placeOrder({ side: 'BUY', quantity: '1', limitPrice: '100', ... });
 * await runtime.placeOrder({ side: 'SELL', quantity: '1', limitPrice: '100', ... });
 * // Вторая команда создаст TradeExecuted, SettlementApplied, projections и WS tick.
 * ```
 */
export class TradingRuntimeProcessor implements TradingCommandPort {
  private readonly engines = new Map<string, MatchingEngine>();
  private readonly orderStates = new Map<string, RuntimeOrderState>();
  private readonly results = new Map<string, GatewayCommandResult>();
  private projectionSequence = 0;

  constructor(
    private readonly instruments: InstrumentCatalogService,
    private readonly ledger: LedgerPort,
    private readonly settlement: SettlementService,
    private readonly projections: ProjectionStore,
    private readonly marketData: MarketDataHub,
  ) {}

  /**
   * Выполняет полный path place command: validate → reserve → match → settle.
   *
   * Результат сохраняется по commandId, поэтому повтор команды не создаёт
   * второй reserve или вторую сделку. Rejection до matching не меняет book; если
   * matching отклонил уже зарезервированную заявку, резерв освобождается.
   */
  async placeOrder(command: GatewayPlaceOrderCommand): Promise<GatewayCommandResult> {
    const previous = this.results.get(command.commandId);
    if (previous) return previous;

    const instrument = this.instruments.get(command.instrumentId);
    const quantity = Decimal.from(command.quantity);
    const price = command.limitPrice ? Decimal.from(command.limitPrice) : Decimal.from('0');
    this.assertRules(instrument, command, quantity, price);

    const state: RuntimeOrderState = {
      orderId: command.clientOrderId,
      userId: command.userId,
      accountId: createId<'AccountId'>(command.accountId),
      instrumentId: command.instrumentId,
      side: command.side,
      baseAssetId: createId<'AssetId'>(instrument.baseAssetId),
      quoteAssetId: createId<'AssetId'>(instrument.quoteAssetId),
      quantity,
      price,
    };
    await this.reserve(state);

    const matchingCommand: MatchingCommand = {
      type: 'PLACE',
      orderId: command.clientOrderId,
      userId: command.userId,
      side: command.side,
      orderType: command.orderType,
      quantity,
      ...(command.limitPrice ? { price } : {}),
      timeInForce: command.timeInForce,
    };
    const events = this.engine(command.instrumentId).apply(matchingCommand);
    if (events.some((event) => event.kind === 'ORDER_REJECTED')) {
      await this.release(state, 'matching-rejected');
      throw new TradingRuntimeRejection('ORDER_REJECTED');
    }

    this.orderStates.set(command.clientOrderId, state);
    await this.applyEvents(command.commandId, command.instrumentId, events);
    const result = {
      commandId: command.commandId,
      orderId: command.clientOrderId,
      status: 'ACCEPTED',
    } as const;
    this.results.set(command.commandId, result);
    return result;
  }

  /** Выполняет cancel через matching engine и освобождает неиспользованный reserve. */
  async cancelOrder(command: GatewayCancelOrderCommand): Promise<GatewayCommandResult> {
    const previous = this.results.get(command.commandId);
    if (previous) return previous;
    const events = this.engine(command.instrumentId).apply({
      type: 'CANCEL',
      orderId: command.orderId,
    });
    if (events.some((event) => event.kind === 'ORDER_REJECTED')) {
      throw new TradingRuntimeRejection('ORDER_CANCEL_REJECTED');
    }
    const state = this.orderStates.get(command.orderId);
    if (state) await this.release(state, 'cancelled');
    await this.applyEvents(command.commandId, command.instrumentId, events);
    const result = {
      commandId: command.commandId,
      orderId: command.orderId,
      status: 'CANCEL_ACCEPTED',
    } as const;
    this.results.set(command.commandId, result);
    return result;
  }

  /** Возвращает последний public command result владельца. */
  async getOrder(userId: string, orderId: string): Promise<GatewayCommandResult | null> {
    await Promise.resolve();
    const state = this.orderStates.get(orderId);
    if (!state || state.userId !== userId) return null;
    return [...this.results.values()].find((result) => result.orderId === orderId) ?? null;
  }

  /** Возвращает bounded page command results владельца. */
  async listOrders(
    userId: string,
    limit: number,
    cursor?: string,
  ): Promise<Readonly<{ items: readonly GatewayCommandResult[]; nextCursor: string | null }>> {
    await Promise.resolve();
    const start = Number(cursor ?? 0);
    const items = [...this.results.values()].filter((result) => {
      const state = this.orderStates.get(result.orderId);
      return state?.userId === userId;
    });
    const page = items.slice(start, start + limit);
    return {
      items: page,
      nextCursor: start + page.length < items.length ? String(start + page.length) : null,
    };
  }

  /** Проверяет lifecycle, tick/lot/min/max/price band rules фиксированной версии. */
  private assertRules(
    instrument: InstrumentSnapshot,
    command: GatewayPlaceOrderCommand,
    quantity: Decimal,
    price: Decimal,
  ): void {
    if (instrument.status !== 'ACTIVE') throw new TradingRuntimeRejection('INSTRUMENT_PAUSED');
    const rules = [...instrument.rules]
      .filter((item) => item.effectiveAt <= new Date())
      .sort((left, right) => left.effectiveAt.getTime() - right.effectiveAt.getTime())
      .at(-1);
    if (!rules) throw new TradingRuntimeRejection('INSTRUMENT_RULES_MISSING');
    if (
      quantity.isNegative() ||
      quantity.isZero() ||
      !quantity.isMultipleOf(rules.lotSize) ||
      quantity.compare(rules.minQuantity) < 0 ||
      quantity.compare(rules.maxQuantity) > 0
    ) {
      throw new TradingRuntimeRejection('INVALID_QUANTITY');
    }
    if (command.orderType === 'LIMIT') {
      if (!command.limitPrice) throw new TradingRuntimeRejection('LIMIT_PRICE_REQUIRED');
      if (
        !price.isMultipleOf(rules.tickSize) ||
        price.compare(rules.priceBand.min) < 0 ||
        price.compare(rules.priceBand.max) > 0
      ) {
        throw new TradingRuntimeRejection('INVALID_PRICE');
      }
    } else if (command.limitPrice) {
      throw new TradingRuntimeRejection('MARKET_PRICE_NOT_ALLOWED');
    }
  }

  /** Выполняет reserve-before-place через settlement boundary. */
  private async reserve(state: RuntimeOrderState): Promise<void> {
    await this.settlement.reserveBeforePlace({
      orderId: state.orderId,
      accountId: state.accountId,
      side: state.side,
      baseAssetId: state.baseAssetId,
      quoteAssetId: state.quoteAssetId,
      quantity: state.quantity,
      price: state.price,
      feeRate: Decimal.from('0'),
    });
  }

  /** Освобождает неиспользованный reserve для rejected/cancelled order. */
  private async release(state: RuntimeOrderState, reason: string): Promise<void> {
    const asset = state.side === 'BUY' ? state.quoteAssetId : state.baseAssetId;
    const amount = state.side === 'BUY' ? state.quantity.multiply(state.price) : state.quantity;
    await this.ledger.release(
      createId<'OperationId'>(`release-${state.orderId}-${reason}`),
      state.accountId,
      asset,
      amount,
    );
  }

  /** Применяет committed matching events к settlement, projections и market data. */
  private async applyEvents(
    commandId: string,
    instrumentId: string,
    events: readonly MatchingEvent[],
  ): Promise<void> {
    for (const event of events) {
      if (event.kind === 'ORDER_ACCEPTED' || event.kind === 'ORDER_CANCELLED') {
        this.projections.apply({
          eventId: `projection-${commandId}-${event.kind}-${event.sequence}`,
          eventType: event.kind === 'ORDER_ACCEPTED' ? 'OrderAccepted' : 'OrderCancelled',
          sequence: this.nextProjectionSequence(),
          correlationId: commandId,
          causationId: commandId,
          payload: {
            orderId: event.orderId,
            userId: this.orderStates.get(event.orderId)?.userId ?? '',
            accountId: this.orderStates.get(event.orderId)?.accountId ?? '',
            instrumentId,
            remainingQuantity: event.remainingQuantity,
          },
        });
      }
      if (event.kind === 'TRADE_EXECUTED') {
        await this.applyTrade(commandId, instrumentId, event);
      }
    }
    this.publishBookSnapshot(instrumentId);
  }

  /** Создаёт TradeExecuted, запускает settlement и публикует public/private events. */
  private async applyTrade(
    commandId: string,
    instrumentId: string,
    event: Extract<MatchingEvent, { kind: 'TRADE_EXECUTED' }>,
  ): Promise<void> {
    const maker = this.requireOrder(event.makerOrderId);
    const taker = this.requireOrder(event.takerOrderId);
    const trade: TradeExecuted = {
      eventId: `trade-event-${event.sequence}-${event.makerOrderId}-${event.takerOrderId}`,
      correlationId: commandId,
      causationId: commandId,
      tradeId: `trade-${event.sequence}-${event.makerOrderId}-${event.takerOrderId}`,
      makerOrderId: event.makerOrderId,
      takerOrderId: event.takerOrderId,
      makerAccountId: maker.accountId,
      takerAccountId: taker.accountId,
      makerSide: maker.side,
      quantity: Decimal.from(event.quantity),
      price: Decimal.from(event.price),
      makerFee: Decimal.from('0'),
      takerFee: Decimal.from('0'),
      feeAssetId: maker.quoteAssetId,
      quoteAssetId: maker.quoteAssetId,
      baseAssetId: maker.baseAssetId,
    };
    await this.settlement.appendTrade(trade);
    const settlement = await this.settlement.settleTrade(trade);
    this.projections.apply({
      eventId: trade.eventId,
      eventType: 'TradeExecuted',
      sequence: this.nextProjectionSequence(),
      correlationId: commandId,
      causationId: commandId,
      payload: {
        tradeId: trade.tradeId,
        instrumentId,
        makerUserId: event.makerUserId,
        takerUserId: event.takerUserId,
        makerOrderId: event.makerOrderId,
        takerOrderId: event.takerOrderId,
        quantity: event.quantity,
        price: event.price,
      },
    });
    this.projections.apply({
      eventId: settlement.eventId,
      eventType: 'SettlementApplied',
      sequence: this.nextProjectionSequence(),
      correlationId: commandId,
      causationId: trade.eventId,
      payload: { settlementId: settlement.settlementId, tradeId: trade.tradeId, postings: [] },
    });
    this.marketData.publishTick({
      channel: 'trades',
      instrumentId,
      sequence: event.sequence,
      price: event.price,
      quantity: event.quantity,
    });
    for (const userId of [event.makerUserId, event.takerUserId]) {
      this.marketData.publishPrivate({
        channel: 'user',
        userId,
        sequence: event.sequence,
        type: 'trade',
        payload: { tradeId: trade.tradeId, instrumentId },
      });
    }
  }

  /** Публикует публичный snapshot активного стакана после committed command. */
  private publishBookSnapshot(instrumentId: string): void {
    const orders = this.engine(instrumentId).getActiveOrders();
    this.marketData.publishSnapshot({
      channel: 'book',
      instrumentId,
      sequence: this.engine(instrumentId).getLastSequence(),
      bids: orders
        .filter((order) => order.side === 'BUY' && order.price)
        .map((order) => ({
          price: order.price?.toString() ?? '0',
          quantity: order.remainingQuantity.toString(),
        })),
      asks: orders
        .filter((order) => order.side === 'SELL' && order.price)
        .map((order) => ({
          price: order.price?.toString() ?? '0',
          quantity: order.remainingQuantity.toString(),
        })),
    });
  }

  private engine(instrumentId: string): MatchingEngine {
    const engine = this.engines.get(instrumentId) ?? new MatchingEngine();
    this.engines.set(instrumentId, engine);
    return engine;
  }

  /** Выдаёт contiguous sequence для projection consumer независимо от book sequence. */
  private nextProjectionSequence(): number {
    this.projectionSequence += 1;
    return this.projectionSequence;
  }

  private requireOrder(orderId: string): RuntimeOrderState {
    const state = this.orderStates.get(orderId);
    if (!state)
      throw new BadRequestException({
        code: 'ORDER_STATE_MISSING',
        message: 'Order state is missing',
      });
    return state;
  }
}
