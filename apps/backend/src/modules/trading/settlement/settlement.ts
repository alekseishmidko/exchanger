import {
  AssetId,
  createId,
  Decimal,
  AccountId,
  OperationId,
  AtomicExecutionPort,
  DIRECT_ATOMIC_EXECUTION,
} from '../../shared-kernel';
import { LedgerPort, OperationResult } from '../../ledger';
import { EventLogPort } from '../event-log';
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
import { SettlementEventMapper } from './mappers/settlement-event.mapper';
import { SettlementPostingPolicy } from './policies/settlement-posting.policy';

/** Данные заявки, необходимые для предварительного резервирования. */
export type OrderToReserve = Readonly<{
  orderId: string;
  accountId: AccountId;
  side: 'BUY' | 'SELL';
  baseAssetId: AssetId;
  quoteAssetId: AssetId;
  quantity: Decimal;
  price: Decimal;
  feeRate: Decimal;
}>;

/** Событие результата matching engine для settlement consumer. */
export type TradeExecuted = Readonly<{
  eventId: string;
  correlationId?: string;
  causationId?: string;
  tradeId: string;
  makerOrderId: string;
  takerOrderId: string;
  makerAccountId: AccountId;
  takerAccountId: AccountId;
  makerSide: 'BUY' | 'SELL';
  quantity: Decimal;
  price: Decimal;
  makerFee: Decimal;
  takerFee: Decimal;
  feeAssetId: AssetId;
  quoteAssetId: AssetId;
  baseAssetId: AssetId;
}>;

/**
 * JSON-представление `TradeExecuted` для durable event log.
 *
 * Decimal-поля намеренно представлены строками: например, цена `100.25`
 * сохраняется как `"100.25"`, а не как IEEE-754 number и не как внутренний
 * объект `Decimal` с `bigint`, который JSON не умеет сериализовать.
 */
export type TradeExecutedPayload = Readonly<
  Omit<TradeExecuted, 'quantity' | 'price' | 'makerFee' | 'takerFee'> & {
    quantity: string;
    price: string;
    makerFee: string;
    takerFee: string;
  }
>;

/** Событие завершённого settlement с ссылками на ledger postings. */
export type SettlementApplied = Readonly<{
  eventId: string;
  correlationId?: string;
  causationId?: string;
  settlementId: string;
  tradeId: string;
  postingIds: readonly string[];
}>;

/** Результат резервирования суммы заявки. */
export type ReservationResult = Readonly<{
  orderId: string;
  reserved: Decimal;
  fee: Decimal;
  operationIds: readonly OperationId[];
}>;

/** Выполняет reserve-before-place и idempotent trade settlement. */
export class SettlementService {
  private readonly reservations = new Map<string, ReservationResult>();
  private readonly applied = new Map<string, SettlementApplied>();
  private readonly events = new SettlementEventMapper();
  private readonly postings = new SettlementPostingPolicy();

  /**
   * Создаёт settlement orchestrator поверх ledger и durable event-log ports.
   *
   * `feeScale` задаёт единое детерминированное округление комиссий. Telemetry и
   * metrics наблюдают весь settlement, но не получают account IDs, суммы или
   * цены как labels/attributes. No-op defaults сохраняют чистоту domain tests.
   *
   * @param ledger Ledger boundary для сбалансированных idempotent postings.
   * @param eventLog Append-only журнал результата settlement.
   * @param feeScale Число знаков после запятой при округлении maker/taker fee.
   * @param logger Operational success/failure события settlement.
   * @param telemetry Port для `settlement.apply` span.
   * @param metrics Счётчики applied/failed settlement с bounded reason.
   * @param atomic Transaction boundary полного posting/outbox use case.
   */
  constructor(
    private readonly ledger: LedgerPort,
    private readonly eventLog: EventLogPort,
    private readonly feeScale = 8,
    private readonly logger: OperationalLogger = NOOP_OPERATIONAL_LOGGER,
    private readonly telemetry: TelemetryPort = NOOP_TELEMETRY,
    private readonly metrics: OperationalMetrics = NOOP_OPERATIONAL_METRICS,
    private readonly atomic: AtomicExecutionPort = DIRECT_ATOMIC_EXECUTION,
  ) {}

  /** Резервирует base либо quote+fee до допуска заявки в matching engine. */
  async reserveBeforePlace(order: OrderToReserve): Promise<ReservationResult> {
    const existing = this.reservations.get(order.orderId);
    if (existing) return existing;
    const result = await this.atomic.execute(() => this.reserveBeforePlaceAtomic(order));
    this.reservations.set(order.orderId, result);
    return result;
  }

  /**
   * Выполняет все операции reserve одной заявки внутри общей transaction.
   *
   * Для SELL это особенно важно: резерв base и резерв quote-комиссии либо
   * фиксируются вместе, либо оба откатываются. Метод не изменяет process-local
   * cache — он обновляется вызывающим методом только после успешного commit.
   */
  private async reserveBeforePlaceAtomic(order: OrderToReserve): Promise<ReservationResult> {
    const notional = order.quantity.multiply(order.price);
    const fee = notional.multiply(order.feeRate).round(this.feeScale);
    const operations: OperationId[] = [];
    if (order.side === 'BUY') {
      const total = notional.add(fee);
      const operationId = createId<'OperationId'>(`reserve-${order.orderId}-quote`);
      await this.ledger.reserve(operationId, order.accountId, order.quoteAssetId, total);
      operations.push(operationId);
      return { orderId: order.orderId, reserved: total, fee, operationIds: operations };
    }
    const baseOperationId = createId<'OperationId'>(`reserve-${order.orderId}-base`);
    await this.ledger.reserve(baseOperationId, order.accountId, order.baseAssetId, order.quantity);
    operations.push(baseOperationId);
    if (!fee.isZero()) {
      const feeOperationId = createId<'OperationId'>(`reserve-${order.orderId}-fee`);
      await this.ledger.reserve(feeOperationId, order.accountId, order.quoteAssetId, fee);
      operations.push(feeOperationId);
    }
    return {
      orderId: order.orderId,
      reserved: order.quantity,
      fee,
      operationIds: operations,
    };
  }

  /** Публикует TradeExecuted с retry на временный timeout event log. */
  async appendTrade(event: TradeExecuted, maxRetries = 3): Promise<void> {
    for (let attempt = 0; attempt < maxRetries; attempt += 1) {
      try {
        await this.eventLog.append({
          eventId: event.eventId,
          eventType: 'TradeExecuted',
          payload: this.events.serializeTrade(event),
          ...(event.correlationId ? { correlationId: event.correlationId } : {}),
          ...(event.causationId ? { causationId: event.causationId } : {}),
        });
        return;
      } catch (error) {
        if (attempt === maxRetries - 1) {
          this.logger.failure('settlement', LOG_EVENTS.SETTLEMENT_REJECTED, {
            eventId: event.eventId,
            metadata: { tradeId: event.tradeId, reason: 'EVENT_LOG_UNAVAILABLE' },
          });
          throw error;
        }
        this.logger.warn('settlement', LOG_EVENTS.SETTLEMENT_RETRY, {
          eventId: event.eventId,
          outcome: 'retry',
          metadata: { tradeId: event.tradeId, attempt: attempt + 1 },
        });
      }
    }
  }

  /**
   * Применяет trade ровно один раз и публикует `SettlementApplied`.
   *
   * Span охватывает вычисление posting matrix, ledger commits и append события.
   * Успешная метрика увеличивается только после завершения Promise; исключение
   * сохраняется вызывающему коду и учитывается как settlement failure.
   *
   * @param event Исполненная сделка с maker/taker accounts, assets и fee policy.
   * @returns Идемпотентный результат со всеми идентификаторами проводок.
   */
  async settleTrade(event: TradeExecuted): Promise<SettlementApplied> {
    try {
      const result = await this.atomic.execute(() =>
        this.telemetry.span(TRACE_SPANS.SETTLEMENT_APPLY, { 'trade.side': event.makerSide }, () =>
          this.settleTradeObserved(event),
        ),
      );
      this.applied.set(event.tradeId, result);
      this.metrics.observeSettlement('applied');
      return result;
    } catch (error) {
      this.metrics.observeSettlement('failed', 'invariant');
      throw error;
    }
  }

  /** Создаёт полный posting set и событие внутри settlement tracing boundary. */
  private async settleTradeObserved(event: TradeExecuted): Promise<SettlementApplied> {
    const previous = this.applied.get(event.tradeId);
    if (previous) return previous;
    const plan = this.postings.buildPlan(event);
    const operationIds: OperationResult[] = [];
    operationIds.push(
      await this.ledger.settleReservedTransfer(
        createId<'OperationId'>(`settle-${event.tradeId}-base`),
        plan.sellerAccountId,
        plan.buyerAccountId,
        event.baseAssetId,
        event.quantity,
      ),
    );
    operationIds.push(
      await this.ledger.settleReservedTransfer(
        createId<'OperationId'>(`settle-${event.tradeId}-quote`),
        plan.buyerAccountId,
        plan.sellerAccountId,
        event.quoteAssetId,
        plan.value,
      ),
    );
    if (!plan.buyerFee.isZero()) {
      operationIds.push(
        await this.ledger.settleReservedTransfer(
          createId<'OperationId'>(`settle-${event.tradeId}-buyer-fee`),
          plan.buyerAccountId,
          await this.feeAccount(event.feeAssetId),
          event.feeAssetId,
          plan.buyerFee,
        ),
      );
    }
    if (!plan.sellerFee.isZero()) {
      operationIds.push(
        await this.ledger.settleReservedTransfer(
          createId<'OperationId'>(`settle-${event.tradeId}-seller-fee`),
          plan.sellerAccountId,
          await this.feeAccount(event.feeAssetId),
          event.feeAssetId,
          plan.sellerFee,
        ),
      );
    }
    const result = this.events.toSettlementApplied(
      event,
      operationIds.flatMap(({ postingIds }) => postingIds.map(String)),
    );
    await this.eventLog.append({
      eventId: result.eventId,
      eventType: 'SettlementApplied',
      payload: result,
      ...(result.correlationId ? { correlationId: result.correlationId } : {}),
      causationId: event.eventId,
    });
    this.logger.info('settlement', LOG_EVENTS.SETTLEMENT_APPLIED, {
      eventId: result.eventId,
      correlationId: result.correlationId,
      causationId: event.eventId,
      metadata: { tradeId: event.tradeId, postingCount: result.postingIds.length },
    });
    return result;
  }

  /** Обрабатывает log consumer с offset/retry и idempotent duplicate delivery. */
  async consumeTrades(maxRetries = 3): Promise<void> {
    await this.eventLog.consume(async (event) => {
      if (event.eventType === 'TradeExecuted') {
        await this.settleTrade(this.deserializeTrade(event.payload));
      }
    }, maxRetries);
  }

  private deserializeTrade(payload: unknown): TradeExecuted {
    return this.events.deserializeTrade(payload);
  }

  /** Находит заранее provisioned fee account для заданного asset. */
  private async feeAccount(assetId: AssetId): Promise<AccountId> {
    const accountId = createId<'AccountId'>(`fees-${assetId}`);
    try {
      await this.ledger.getBalance(accountId, assetId);
    } catch {
      throw new Error('Fee account must be provisioned before settlement');
    }
    return accountId;
  }
}
