import { AccountId, AssetId, createId, Decimal } from '../../src/modules/shared-kernel';
import type { TradeExecuted } from '../../src/modules/trading/settlement';

/** Параметры test command journal/admission command builder. */
export type DurablePlaceOrderCommandOptions = Readonly<{
  number?: number;
  commandId?: string;
  idempotencyKey?: string;
  userId?: string;
  accountId?: string;
  instrumentId?: string;
  clientOrderId?: string;
  side?: 'BUY' | 'SELL';
  quantity?: string;
  limitPrice?: string;
}>;

/**
 * Создаёт публичную команду place order для durable PostgreSQL specs.
 *
 * Builder убирает из integration tests шум неизменяемых полей (`orderType`,
 * `timeInForce`, базовые account/user IDs), оставляя в сценарии только то, что
 * важно для инварианта: command id, idempotency key, instrument и sequence.
 */
export function durablePlaceOrderCommand(options: DurablePlaceOrderCommandOptions = {}) {
  const number = options.number ?? 1;
  return {
    commandId: options.commandId ?? `command-${number}`,
    idempotencyKey: options.idempotencyKey ?? `key-${number}`,
    userId: options.userId ?? 'user-1',
    accountId: options.accountId ?? 'account-1',
    instrumentId: options.instrumentId ?? 'BTC-USD',
    clientOrderId: options.clientOrderId ?? `order-${number}`,
    side: options.side ?? ('BUY' as const),
    orderType: 'LIMIT' as const,
    quantity: options.quantity ?? '1',
    limitPrice: options.limitPrice ?? '100',
    timeInForce: 'GTC' as const,
  };
}

/** IDs common settlement сценария с buyer/seller/fee accounts. */
export function settlementFixtureIds() {
  return {
    btc: createId<'AssetId'>('BTC'),
    usd: createId<'AssetId'>('USD'),
    buyer: createId<'AccountId'>('buyer'),
    seller: createId<'AccountId'>('seller'),
    fees: createId<'AccountId'>('fees-USD'),
  };
}

/** Создаёт TradeExecuted для PostgreSQL settlement integration scenario. */
export function settlementTradeFixture(ids: {
  buyer: AccountId;
  seller: AccountId;
  usd: AssetId;
  btc: AssetId;
}): TradeExecuted {
  return {
    eventId: 'trade-event-1',
    tradeId: 'trade-1',
    makerOrderId: 'maker-1',
    takerOrderId: 'taker-1',
    makerAccountId: ids.buyer,
    takerAccountId: ids.seller,
    makerSide: 'BUY',
    quantity: Decimal.from('2'),
    price: Decimal.from('100'),
    makerFee: Decimal.from('2'),
    takerFee: Decimal.from('2'),
    feeAssetId: ids.usd,
    quoteAssetId: ids.usd,
    baseAssetId: ids.btc,
  };
}
