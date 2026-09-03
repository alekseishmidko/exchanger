import { AssetId, createId, Decimal, AccountId, OperationId } from '../../shared-kernel';
import { Ledger, OperationResult } from '../../ledger';
import { EventLog } from '../event-log';

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

  constructor(
    private readonly ledger: Ledger,
    private readonly eventLog: EventLog,
    private readonly feeScale = 8,
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
        });
        return;
      } catch (error) {
        if (attempt === maxRetries - 1) throw error;
      }
    }
  }

  /** Применяет trade ровно один раз и публикует SettlementApplied. */
  async settleTrade(event: TradeExecuted): Promise<SettlementApplied> {
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
      settlementId: `settlement-${event.tradeId}`,
      tradeId: event.tradeId,
      postingIds: operationIds.flatMap(({ postingIds }) => postingIds.map(String)),
    };
    this.applied.set(event.tradeId, result);
    await this.eventLog.append({
      eventId: result.eventId,
      eventType: 'SettlementApplied',
      payload: result,
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
