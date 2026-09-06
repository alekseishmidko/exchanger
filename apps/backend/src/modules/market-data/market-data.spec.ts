import { ForbiddenException } from '@nestjs/common';
import { BackpressureError, MarketDataGapError, MarketDataHub } from './market-data';

/** Проверяет snapshot/increment protocol, recovery, isolation и backpressure. */
describe('MarketDataHub', () => {
  const snapshot = {
    channel: 'book' as const,
    instrumentId: 'BTC-USD',
    sequence: 1,
    bids: [{ price: '99', quantity: '2' }],
    asks: [{ price: '101', quantity: '3' }],
  };
  it('sends consistent snapshot and ordered increments with resync', () => {
    const hub = new MarketDataHub();
    hub.publishSnapshot(snapshot);
    const messages: string[] = [];
    const unsubscribe = hub.subscribePublic('client-1', 'BTC-USD', 'book', (message) =>
      messages.push(`${message.channel}:${message.sequence}`),
    );
    hub.publishIncrement({
      channel: 'book_update',
      instrumentId: 'BTC-USD',
      sequence: 2,
      bids: [{ price: '99', quantity: '1' }],
      asks: [],
    });
    expect(messages).toEqual(['book:1', 'book_update:2']);
    expect(hub.resync('BTC-USD', 1)).toHaveLength(1);
    unsubscribe();
  });
  it('detects gap and supports reconnect from current snapshot', () => {
    const hub = new MarketDataHub();
    hub.publishSnapshot(snapshot);
    expect(() =>
      hub.publishIncrement({ ...snapshot, channel: 'book_update', sequence: 3 }),
    ).toThrow(MarketDataGapError);
    expect(hub.resync('BTC-USD', 0)[0]?.channel).toBe('book');
  });
  it('protects private stream and prevents leakage', () => {
    const hub = new MarketDataHub();
    const received: string[] = [];
    hub.subscribePrivate('client-1', 'u-1', 'u-1', (event) => received.push(event.channel));
    expect(() => hub.subscribePrivate('client-2', 'u-2', 'u-1', () => undefined)).toThrow(
      ForbiddenException,
    );
    hub.publishPrivate({ channel: 'user', userId: 'u-1', sequence: 1, type: 'ORDER', payload: {} });
    hub.publishPrivate({ channel: 'user', userId: 'u-2', sequence: 1, type: 'ORDER', payload: {} });
    expect(received).toEqual(['user']);
  });
  it('fans out trades and ticker only to their channel', () => {
    const hub = new MarketDataHub();
    hub.publishSnapshot(snapshot);
    const received: string[] = [];
    hub.subscribePublic('trade-client', 'BTC-USD', 'trades', (event) =>
      received.push(event.channel),
    );
    hub.subscribePublic('ticker-client', 'BTC-USD', 'ticker', (event) =>
      received.push(event.channel),
    );
    hub.publishTick({
      channel: 'trades',
      instrumentId: 'BTC-USD',
      sequence: 2,
      price: '100',
      quantity: '1',
    });
    hub.publishTick({
      channel: 'ticker',
      instrumentId: 'BTC-USD',
      sequence: 3,
      price: '101',
      quantity: '2',
    });
    expect(received).toEqual(['trades', 'ticker']);
  });
  it('disconnects slow consumer and enforces fan-out capacity', () => {
    const hub = new MarketDataHub(1, 0);
    hub.publishSnapshot(snapshot);
    hub.subscribePublic('client-1', 'BTC-USD', 'book', () => undefined);
    expect(() =>
      hub.publishIncrement({
        channel: 'book_update',
        instrumentId: 'BTC-USD',
        sequence: 2,
        bids: [],
        asks: [],
      }),
    ).toThrow(BackpressureError);
  });
});
