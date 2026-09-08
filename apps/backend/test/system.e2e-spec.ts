import { Account, Asset, Ledger } from '../src/modules/ledger';
import { ProjectionStore } from '../src/modules/projections/projection';
import { createId, Decimal } from '../src/modules/shared-kernel';
import { EventLog } from '../src/modules/trading/event-log';
import {
  MatchingCommand,
  MatchingEngine,
  MatchingEvent,
  TradeEvent,
} from '../src/modules/trading/matching-engine/matching-engine';
import { SettlementService, TradeExecuted } from '../src/modules/trading/settlement';
import { TradingStateMachine } from '../src/modules/trading/state-machine';

/**
 * Сквозная системная проверка write path и последующего read model.
 *
 * Сценарий проходит account → funding balance → reserve → deterministic matching
 * → settlement → event archive → projection history. Повтор command и trade event
 * проверяется на отсутствие второго business effect, а fresh replay сравнивается
 * с результатом до условного restart.
 */
describe('Exchange system E2E', () => {
  it('settles one trade, survives duplicate delivery and rebuilds history after restart', async () => {
    const btc = createId<'AssetId'>('BTC');
    const usd = createId<'AssetId'>('USD');
    const buyer = createId<'AccountId'>('buyer');
    const seller = createId<'AccountId'>('seller');
    const fee = createId<'AccountId'>('fees-USD');
    const ledger = new Ledger();
    ledger.registerAsset(new Asset(btc, 'BTC', 8));
    ledger.registerAsset(new Asset(usd, 'USD', 2));
    for (const account of [
      new Account(buyer, 'buyer'),
      new Account(seller, 'seller'),
      new Account(fee, 'system-fees'),
    ]) {
      ledger.registerAccount(account);
      ledger.openBalance(account.id, btc);
      ledger.openBalance(account.id, usd);
    }
    ledger.credit(createId<'OperationId'>('fund-buyer'), buyer, usd, Decimal.from('1000'));
    ledger.credit(createId<'OperationId'>('fund-seller-btc'), seller, btc, Decimal.from('10'));
    ledger.credit(createId<'OperationId'>('fund-seller-usd'), seller, usd, Decimal.from('10'));

    const eventLog = new EventLog();
    const settlement = new SettlementService(ledger, eventLog, 2);
    settlement.reserveBeforePlace({
      orderId: 'buy-order',
      accountId: buyer,
      side: 'BUY',
      baseAssetId: btc,
      quoteAssetId: usd,
      quantity: Decimal.from('2'),
      price: Decimal.from('100'),
      feeRate: Decimal.from('0.01'),
    });
    settlement.reserveBeforePlace({
      orderId: 'sell-order',
      accountId: seller,
      side: 'SELL',
      baseAssetId: btc,
      quoteAssetId: usd,
      quantity: Decimal.from('2'),
      price: Decimal.from('100'),
      feeRate: Decimal.from('0.01'),
    });

    const commands: readonly MatchingCommand[] = [
      {
        type: 'PLACE',
        orderId: 'sell-order',
        userId: 'seller',
        side: 'SELL',
        orderType: 'LIMIT',
        price: Decimal.from('100'),
        quantity: Decimal.from('2'),
        timeInForce: 'GTC',
      },
      {
        type: 'PLACE',
        orderId: 'buy-order',
        userId: 'buyer',
        side: 'BUY',
        orderType: 'LIMIT',
        price: Decimal.from('100'),
        quantity: Decimal.from('2'),
        timeInForce: 'GTC',
      },
    ];
    const engine = new MatchingEngine();
    const machine = new TradingStateMachine<MatchingCommand, readonly MatchingEvent[]>(
      'BTC-USD',
      (command) => engine.apply(command),
      { now: () => new Date('2026-09-08T00:00:00Z') },
    );
    const sellResult = machine.apply({
      commandId: 'place-sell',
      instrumentId: 'BTC-USD',
      sequence: 1,
      payload: commands[0]!,
    });
    const buyCommand = {
      commandId: 'place-buy',
      instrumentId: 'BTC-USD',
      sequence: 2,
      payload: commands[1]!,
    } as const;
    const buyResult = machine.apply(buyCommand);
    expect(machine.apply(buyCommand)).toEqual(buyResult);
    expect(engine.getLastSequence()).toBe(2);

    const matched = buyResult.find((event): event is TradeEvent => event.kind === 'TRADE_EXECUTED');
    expect(matched).toBeDefined();
    const trade: TradeExecuted = {
      eventId: 'trade-event-1',
      tradeId: 'trade-1',
      makerOrderId: matched!.makerOrderId,
      takerOrderId: matched!.takerOrderId,
      makerAccountId: seller,
      takerAccountId: buyer,
      makerSide: 'SELL',
      quantity: Decimal.from(matched!.quantity),
      price: Decimal.from(matched!.price),
      makerFee: Decimal.from('2'),
      takerFee: Decimal.from('2'),
      feeAssetId: usd,
      quoteAssetId: usd,
      baseAssetId: btc,
    };
    await settlement.appendTrade(trade);
    const applied = await settlement.settleTrade(trade);
    const postingCount = ledger.getPostings().length;
    expect(await settlement.settleTrade(trade)).toEqual(applied);
    expect(ledger.getPostings()).toHaveLength(postingCount);
    expect(ledger.getBalance(buyer, btc).available.toString()).toBe('2');
    expect(() => ledger.reconcile()).not.toThrow();

    const projection = new ProjectionStore();
    projection.apply({
      eventId: 'projection-1',
      eventType: 'OrderAccepted',
      sequence: 1,
      payload: {
        orderId: 'sell-order',
        userId: 'seller',
        accountId: 'seller',
        instrumentId: 'BTC-USD',
        remainingQuantity: '2',
      },
    });
    projection.apply({
      eventId: 'projection-2',
      eventType: 'OrderAccepted',
      sequence: 2,
      payload: {
        orderId: 'buy-order',
        userId: 'buyer',
        accountId: 'buyer',
        instrumentId: 'BTC-USD',
        remainingQuantity: '0',
      },
    });
    projection.apply({
      eventId: 'projection-3',
      eventType: 'TradeExecuted',
      sequence: 3,
      payload: {
        tradeId: 'trade-1',
        instrumentId: 'BTC-USD',
        makerOrderId: 'sell-order',
        takerOrderId: 'buy-order',
        makerUserId: 'seller',
        takerUserId: 'buyer',
        quantity: '2',
        price: '100',
      },
    });
    projection.apply({
      eventId: 'projection-4',
      eventType: 'SettlementApplied',
      sequence: 4,
      payload: {
        postings: [
          { accountId: 'buyer', assetId: 'BTC', availableDelta: '2', reservedDelta: '0' },
          { accountId: 'buyer', assetId: 'USD', availableDelta: '0', reservedDelta: '-202' },
        ],
      },
    });
    expect(projection.getOrders('buyer').items).toHaveLength(1);
    expect(projection.getTrades('buyer').items).toHaveLength(1);
    expect(projection.getBalances('buyer').items).toHaveLength(2);

    const archive = eventLog.createArchive(new Date('2026-09-08T00:01:00Z'));
    expect(EventLog.restore(archive).getEvents()).toEqual(eventLog.getEvents());

    const replayStartedAt = performance.now();
    const replayEngine = new MatchingEngine();
    const replayResults = commands.map((command) => replayEngine.apply(command));
    const recoveryTimeMs = performance.now() - replayStartedAt;
    expect(replayResults).toEqual([sellResult, buyResult]);
    expect(recoveryTimeMs).toBeLessThan(1000);
    expect(archive.events).toHaveLength(eventLog.getEvents().length);
  });
});
