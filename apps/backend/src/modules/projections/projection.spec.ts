import { BadRequestException } from '@nestjs/common';
import { ProjectionEvent, ProjectionStore } from './projection';

/** Проверяет восстановление read-моделей, порядок событий и isolation query API. */
describe('ProjectionStore', () => {
  const event = (
    sequence: number,
    eventType: ProjectionEvent['eventType'],
    payload: Record<string, unknown>,
  ): ProjectionEvent => ({ eventId: `event-${sequence}`, eventType, sequence, payload });

  it('projects every supported event and accumulates settlement balances', () => {
    const store = new ProjectionStore();
    store.apply(
      event(1, 'OrderAccepted', {
        orderId: 'o-1',
        userId: 'u-1',
        accountId: 'u-1',
        instrumentId: 'BTC-USD',
        remainingQuantity: '2',
      }),
    );
    store.apply(
      event(2, 'TradeExecuted', {
        tradeId: 't-1',
        instrumentId: 'BTC-USD',
        makerOrderId: 'o-1',
        takerOrderId: 'o-2',
        makerUserId: 'u-1',
        takerUserId: 'u-2',
        quantity: '1.5',
        price: '100',
      }),
    );
    store.apply(
      event(3, 'SettlementApplied', {
        postings: [
          { accountId: 'u-1', assetId: 'USD', availableDelta: '-100', reservedDelta: '0.5' },
          { accountId: 'u-1', assetId: 'USD', availableDelta: '0.25', reservedDelta: '0' },
        ],
      }),
    );
    store.apply(
      event(4, 'OrderCancelled', {
        orderId: 'o-1',
        userId: 'u-1',
        accountId: 'u-1',
        instrumentId: 'BTC-USD',
        remainingQuantity: '0',
      }),
    );
    expect(store.getOrders('u-1').items[0]?.status).toBe('CANCELLED');
    expect(store.getTrades('u-1').items[0]?.tradeId).toBe('t-1');
    expect(store.getBalances('u-1').items[0]).toMatchObject({
      available: '-99.75',
      reserved: '0.5',
    });
  });

  it('ignores duplicate event and rejects sequence gap', () => {
    const store = new ProjectionStore();
    const first = event(1, 'OrderRejected', {
      orderId: 'o-1',
      userId: 'u-1',
      accountId: 'u-1',
      instrumentId: 'BTC-USD',
      reasonCode: 'X',
      remainingQuantity: '0',
    });
    store.apply(first);
    store.apply(first);
    expect(store.getMetrics().appliedSequence).toBe(1);
    expect(() => store.apply(event(3, 'TradeExecuted', {}))).toThrow(BadRequestException);
  });

  it('rebuilds equal to live state and isolates users before pagination', () => {
    const events = [
      event(1, 'OrderAccepted', {
        orderId: 'o-1',
        userId: 'u-1',
        accountId: 'u-1',
        instrumentId: 'BTC-USD',
        remainingQuantity: '1',
      }),
      event(2, 'OrderAccepted', {
        orderId: 'o-2',
        userId: 'u-2',
        accountId: 'u-2',
        instrumentId: 'BTC-USD',
        remainingQuantity: '1',
      }),
    ];
    const live = new ProjectionStore();
    events.forEach((item) => live.apply(item));
    const rebuilt = new ProjectionStore();
    rebuilt.rebuild(events);
    expect(rebuilt.getOrders('u-1', 1)).toEqual(live.getOrders('u-1', 1));
    expect(rebuilt.getOrders('u-1').items).toHaveLength(1);
    expect(rebuilt.getMetrics()).toMatchObject({ schemaVersion: 1, lag: 0 });
  });
});
