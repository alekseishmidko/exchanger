import { EventLog } from '../event-log';
import { Instrument, InstrumentCatalogService } from '../instruments';
import { SettlementService } from '../settlement';
import { MarketDataHub } from '../../market-data';
import { Account, Asset, Ledger } from '../../ledger';
import { ProjectionStore } from '../../projections';
import { createId, Decimal } from '../../shared-kernel';
import { TradingRuntimeProcessor } from './trading-runtime.processor';

/** Создаёт активный BTC-USD instrument с простыми tick/lot rules. */
function registerInstrument(catalog: InstrumentCatalogService): void {
  const instrument = new Instrument(
    'BTC-USD',
    createId<'AssetId'>('BTC'),
    createId<'AssetId'>('USD'),
    {
      version: 'rules-1',
      effectiveAt: new Date('2026-01-01T00:00:00.000Z'),
      tickSize: Decimal.from('1'),
      lotSize: Decimal.from('1'),
      minQuantity: Decimal.from('1'),
      maxQuantity: Decimal.from('10'),
      priceBand: { min: Decimal.from('1'), max: Decimal.from('1000000') },
      feePolicyVersion: 'fee-zero',
      limits: {
        maxOrderQuantity: Decimal.from('10'),
        maxOpenOrders: 100,
        maxNotional: Decimal.from('1000000'),
      },
    },
  );
  instrument.activate();
  catalog.register(instrument);
}

/** Подготавливает ledger balances для двух пользователей spot-сделки. */
function fundLedger(ledger: Ledger): void {
  const usd = createId<'AssetId'>('USD');
  const btc = createId<'AssetId'>('BTC');
  const buyer = createId<'AccountId'>('buyer-account');
  const seller = createId<'AccountId'>('seller-account');
  ledger.registerAsset(new Asset(usd, 'USD', 2));
  ledger.registerAsset(new Asset(btc, 'BTC', 8));
  ledger.registerAccount(new Account(buyer, 'buyer-user'));
  ledger.registerAccount(new Account(seller, 'seller-user'));
  for (const account of [buyer, seller]) {
    ledger.openBalance(account, usd);
    ledger.openBalance(account, btc);
  }
  ledger.credit(createId<'OperationId'>('fund-buyer-usd'), buyer, usd, Decimal.from('1000'));
  ledger.credit(createId<'OperationId'>('fund-seller-btc'), seller, btc, Decimal.from('2'));
}

describe('TradingRuntimeProcessor', () => {
  it('connects public commands to reserve, matching, settlement, projections and market data', async () => {
    const instruments = new InstrumentCatalogService();
    const ledger = new Ledger();
    const eventLog = new EventLog();
    const projections = new ProjectionStore();
    const marketData = new MarketDataHub();
    const settlement = new SettlementService(ledger, eventLog);
    registerInstrument(instruments);
    fundLedger(ledger);
    const runtime = new TradingRuntimeProcessor(
      instruments,
      ledger,
      settlement,
      projections,
      marketData,
    );

    await runtime.placeOrder({
      commandId: 'buy-command',
      idempotencyKey: 'buy-key',
      userId: 'buyer-user',
      accountId: 'buyer-account',
      instrumentId: 'BTC-USD',
      clientOrderId: 'buy-order',
      side: 'BUY',
      orderType: 'LIMIT',
      quantity: '1',
      limitPrice: '100',
      timeInForce: 'GTC',
    });
    const result = await runtime.placeOrder({
      commandId: 'sell-command',
      idempotencyKey: 'sell-key',
      userId: 'seller-user',
      accountId: 'seller-account',
      instrumentId: 'BTC-USD',
      clientOrderId: 'sell-order',
      side: 'SELL',
      orderType: 'LIMIT',
      quantity: '1',
      limitPrice: '100',
      timeInForce: 'GTC',
    });

    expect(result).toEqual({
      commandId: 'sell-command',
      orderId: 'sell-order',
      status: 'ACCEPTED',
      durableStatus: 'ACCEPTED',
      executionStatus: 'APPLIED',
      orderStatus: 'FILLED',
    });
    expect(
      ledger
        .getBalance(createId<'AccountId'>('buyer-account'), createId<'AssetId'>('BTC'))
        .available.toString(),
    ).toBe('1');
    expect(
      ledger
        .getBalance(createId<'AccountId'>('seller-account'), createId<'AssetId'>('USD'))
        .available.toString(),
    ).toBe('100');
    expect(projections.getOrders('buyer-user').items).toHaveLength(1);
    expect(projections.getTrades('buyer-user').items).toHaveLength(1);
    expect(marketData.getSnapshot('BTC-USD')).toMatchObject({
      instrumentId: 'BTC-USD',
      sequence: 2,
      bids: [],
      asks: [],
    });
    expect(eventLog.getEvents().map(({ eventType }) => eventType)).toEqual([
      'TradeExecuted',
      'SettlementApplied',
    ]);
  });
});
