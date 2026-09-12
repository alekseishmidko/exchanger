import { AssetId, createId, Decimal, AccountId, OperationId } from '../../shared-kernel';
import { Ledger, OperationResult } from '../../ledger';
import { EventLog } from '../event-log';
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
   */
  constructor(
    private readonly ledger: Ledger,
    private readonly eventLog: EventLog,
    private readonly feeScale = 8,
    private readonly logger: OperationalLogger = NOOP_OPERATIONAL_LOGGER,
    private readonly telemetry: TelemetryPort = NOOP_TELEMETRY,
    private readonly metrics: OperationalMetrics = NOOP_OPERATIONAL_METRICS,
  ) {}

  /** Резервирует base либо quote+fee до допуска заявки в matching engine. */
  reserveBeforePlace(order: OrderToReserve): ReservationResult {
    const existing = this.reservations.get(order.orderId);
    if (existing) return existing;
    const notional = order.quantity.multiply(order.price);
    const fee = notional.multiply(order.feeRate).round(this.feeScale);
    const operations: OperationId[] = [];
    if (order.side === 'BUY') {
      const total = notional.add(fee);
      const operationId = createId<'OperationId'>(`reserve-${order.orderId}-quote`);
      this.ledger.reserve(operationId, order.accountId, order.quoteAssetId, total);
      operations.push(operationId);
      const result = { orderId: order.orderId, reserved: total, fee, operationIds: operations };
      this.reservations.set(order.orderId, result);
      return result;
    }
    const baseOperationId = createId<'OperationId'>(`reserve-${order.orderId}-base`);
    this.ledger.reserve(baseOperationId, order.accountId, order.baseAssetId, order.quantity);
    operations.push(baseOperationId);
    const feeOperationId = createId<'OperationId'>(`reserve-${order.orderId}-fee`);
    this.ledger.reserve(feeOperationId, order.accountId, order.quoteAssetId, fee);
    operations.push(feeOperationId);
    const result = {
      orderId: order.orderId,
      reserved: order.quantity,
      fee,
      operationIds: operations,
    };
    this.reservations.set(order.orderId, result);
    return result;
  }

  /** Публикует TradeExecuted с retry на временный timeout event log. */
  async appendTrade(event: TradeExecuted, maxRetries = 3): Promise<void> {
    for (let attempt = 0; attempt < maxRetries; attempt += 1) {
      try {
        await this.eventLog.append({
          eventId: event.eventId,
          eventType: 'TradeExecuted',
          payload: event,
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
      const result = await this.telemetry.span(
        TRACE_SPANS.SETTLEMENT_APPLY,
        { 'trade.side': event.makerSide },
        () => this.settleTradeObserved(event),
      );
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
    const makerIsBuyer = event.makerSide === 'BUY';
    const buyerAccountId = makerIsBuyer ? event.makerAccountId : event.takerAccountId;
    const sellerAccountId = makerIsBuyer ? event.takerAccountId : event.makerAccountId;
    const makerFee = event.makerFee;
    const takerFee = event.takerFee;
    const buyerFee = makerIsBuyer ? makerFee : takerFee;
    const sellerFee = makerIsBuyer ? takerFee : makerFee;
    const value = event.quantity.multiply(event.price);
    const operationIds: OperationResult[] = [];
    operationIds.push(
      this.ledger.settleReservedTransfer(
        createId<'OperationId'>(`settle-${event.tradeId}-base`),
        sellerAccountId,
        buyerAccountId,
        event.baseAssetId,
        event.quantity,
      ),
    );
    operationIds.push(
      this.ledger.settleReservedTransfer(
        createId<'OperationId'>(`settle-${event.tradeId}-quote`),
        buyerAccountId,
        sellerAccountId,
        event.quoteAssetId,
        value,
      ),
    );
    if (!buyerFee.isZero()) {
      operationIds.push(
        this.ledger.settleReservedTransfer(
          createId<'OperationId'>(`settle-${event.tradeId}-buyer-fee`),
          buyerAccountId,
          this.feeAccount(event.feeAssetId),
          event.feeAssetId,
          buyerFee,
        ),
      );
    }
    if (!sellerFee.isZero()) {
      operationIds.push(
        this.ledger.settleReservedTransfer(
          createId<'OperationId'>(`settle-${event.tradeId}-seller-fee`),
          sellerAccountId,
          this.feeAccount(event.feeAssetId),
          event.feeAssetId,
          sellerFee,
        ),
      );
    }
    const result: SettlementApplied = {
      eventId: `settlement-event-${event.tradeId}`,
      ...(event.correlationId ? { correlationId: event.correlationId } : {}),
      causationId: event.eventId,
      settlementId: `settlement-${event.tradeId}`,
      tradeId: event.tradeId,
      postingIds: operationIds.flatMap(({ postingIds }) => postingIds.map(String)),
    };
    this.applied.set(event.tradeId, result);
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
        await this.settleTrade(event.payload as TradeExecuted);
      }
    }, maxRetries);
  }

  private feeAccount(assetId: AssetId): AccountId {
    const accountId = createId<'AccountId'>(`fees-${assetId}`);
    try {
      this.ledger.getBalance(accountId, assetId);
    } catch {
      throw new Error('Fee account must be provisioned before settlement');
    }
    return accountId;
  }
}
