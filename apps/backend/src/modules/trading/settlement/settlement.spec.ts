import { Account, Asset, Ledger } from '../../ledger';
import { createId, Decimal } from '../../shared-kernel';
import { EventLog } from '../event-log';
import { SettlementService, TradeExecuted } from './settlement';

const btc = createId<'AssetId'>('BTC');
const usd = createId<'AssetId'>('USD');
const buyer = createId<'AccountId'>('buyer');
const seller = createId<'AccountId'>('seller');
const fee = createId<'AccountId'>('fees-USD');

function setup(): { ledger: Ledger; service: SettlementService } {
  const ledger = new Ledger();
  ledger.registerAsset(new Asset(btc, 'BTC', 8));
  ledger.registerAsset(new Asset(usd, 'USD', 2));
  ledger.registerAccount(new Account(buyer, 'user-buyer'));
  ledger.registerAccount(new Account(seller, 'user-seller'));
  ledger.registerAccount(new Account(fee, 'system-fees'));
  for (const account of [buyer, seller, fee]) {
    ledger.openBalance(account, btc);
    ledger.openBalance(account, usd);
  }
  ledger.credit(createId<'OperationId'>('fund-buyer-usd'), buyer, usd, Decimal.from('1000'));
  ledger.credit(createId<'OperationId'>('fund-seller-btc'), seller, btc, Decimal.from('10'));
  ledger.credit(createId<'OperationId'>('fund-seller-usd'), seller, usd, Decimal.from('10'));
  return { ledger, service: new SettlementService(ledger, new EventLog(), 2) };
}

function trade(tradeId: string, makerSide: 'BUY' | 'SELL', quantity = '2'): TradeExecuted {
  return {
    eventId: `trade-event-${tradeId}`,
    tradeId,
    makerOrderId: `maker-order-${tradeId}`,
    takerOrderId: `taker-order-${tradeId}`,
    makerAccountId: makerSide === 'BUY' ? buyer : seller,
    takerAccountId: makerSide === 'BUY' ? seller : buyer,
    makerSide,
    quantity: Decimal.from(quantity),
    price: Decimal.from('100'),
    makerFee: Decimal.from('2'),
    takerFee: Decimal.from('2'),
    feeAssetId: usd,
    quoteAssetId: usd,
    baseAssetId: btc,
  };
}

describe('SettlementService', () => {
  it('reserves before placement and settles buy/sell with maker/taker fees', async () => {
    const { ledger, service } = setup();
    service.reserveBeforePlace({
      orderId: 'buy-order',
      accountId: buyer,
      side: 'BUY',
      baseAssetId: btc,
      quoteAssetId: usd,
      quantity: Decimal.from('2'),
      price: Decimal.from('100'),
      feeRate: Decimal.from('0.01'),
    });
    service.reserveBeforePlace({
      orderId: 'sell-order',
      accountId: seller,
      side: 'SELL',
      baseAssetId: btc,
      quoteAssetId: usd,
      quantity: Decimal.from('2'),
      price: Decimal.from('100'),
      feeRate: Decimal.from('0.01'),
    });
    const applied = await service.settleTrade(trade('trade-1', 'BUY'));

    expect(applied.postingIds).toHaveLength(8);
    expect(ledger.getBalance(buyer, btc).available.toString()).toBe('2');
    expect(ledger.getBalance(seller, btc).reserved.toString()).toBe('0');
    expect(ledger.getBalance(buyer, usd).reserved.toString()).toBe('0');
    expect(ledger.getBalance(seller, usd).available.toString()).toBe('208');
    expect(ledger.getBalance(fee, usd).available.toString()).toBe('4');
  });

  it('supports multi-fill settlement and exactly-once duplicate event handling', async () => {
    const { ledger, service } = setup();
    service.reserveBeforePlace({
      orderId: 'buy-order',
      accountId: buyer,
      side: 'BUY',
      baseAssetId: btc,
      quoteAssetId: usd,
      quantity: Decimal.from('4'),
      price: Decimal.from('100'),
      feeRate: Decimal.from('0.01'),
    });
    service.reserveBeforePlace({
      orderId: 'sell-order',
      accountId: seller,
      side: 'SELL',
      baseAssetId: btc,
      quoteAssetId: usd,
      quantity: Decimal.from('4'),
      price: Decimal.from('100'),
      feeRate: Decimal.from('0.01'),
    });
    const first = await service.settleTrade(trade('trade-2', 'BUY', '2'));
    await service.settleTrade(trade('trade-2', 'BUY', '2'));

    expect(first).toEqual(await service.settleTrade(trade('trade-2', 'BUY', '2')));
    expect(ledger.getBalance(buyer, btc).available.toString()).toBe('2');
    expect(ledger.getPostings()).toHaveLength(20);
  });

  it('rejects insufficient balance before matching', () => {
    const { service } = setup();
    expect(() =>
      service.reserveBeforePlace({
        orderId: 'too-large',
        accountId: buyer,
        side: 'BUY',
        baseAssetId: btc,
        quoteAssetId: usd,
        quantity: Decimal.from('20'),
        price: Decimal.from('100'),
        feeRate: Decimal.from('0.01'),
      }),
    ).toThrow('Insufficient available balance');
  });

  it('reconciles all settlement postings', async () => {
    const { ledger, service } = setup();
    service.reserveBeforePlace({
      orderId: 'buy-order',
      accountId: buyer,
      side: 'BUY',
      baseAssetId: btc,
      quoteAssetId: usd,
      quantity: Decimal.from('2'),
      price: Decimal.from('100'),
      feeRate: Decimal.from('0.01'),
    });
    service.reserveBeforePlace({
      orderId: 'sell-order',
      accountId: seller,
      side: 'SELL',
      baseAssetId: btc,
      quoteAssetId: usd,
      quantity: Decimal.from('2'),
      price: Decimal.from('100'),
      feeRate: Decimal.from('0.01'),
    });
    await service.settleTrade(trade('trade-3', 'BUY'));
    expect(() => ledger.reconcile()).not.toThrow();
  });
});
