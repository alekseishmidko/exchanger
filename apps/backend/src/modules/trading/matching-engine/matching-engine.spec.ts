import fc from 'fast-check';
import { Decimal } from '../../shared-kernel';
import { MatchingEngine, MatchingCommand } from './matching-engine';

const quantity = (value: string): Decimal => Decimal.from(value);
const limit = (
  orderId: string,
  userId: string,
  side: 'BUY' | 'SELL',
  price: string,
  amount: string,
  timeInForce: 'GTC' | 'IOC' | 'FOK' = 'GTC',
): MatchingCommand => ({
  type: 'PLACE',
  orderId,
  userId,
  side,
  orderType: 'LIMIT',
  price: quantity(price),
  quantity: quantity(amount),
  timeInForce,
});
const market = (
  orderId: string,
  userId: string,
  side: 'BUY' | 'SELL',
  amount: string,
  timeInForce: 'IOC' | 'FOK' = 'IOC',
): MatchingCommand => ({
  type: 'PLACE',
  orderId,
  userId,
  side,
  orderType: 'MARKET',
  quantity: quantity(amount),
  timeInForce,
});

describe('MatchingEngine', () => {
  it('uses passive maker price and price-time priority across levels', () => {
    const engine = new MatchingEngine();
    engine.apply(limit('ask-1', 'maker-1', 'SELL', '101', '1'));
    engine.apply(limit('ask-2', 'maker-2', 'SELL', '100', '1'));
    const events = engine.apply(limit('bid-1', 'taker', 'BUY', '101', '2'));
    const trades = events.filter((event) => event.kind === 'TRADE_EXECUTED');

    expect(trades).toEqual([
      expect.objectContaining({ makerOrderId: 'ask-2', price: '100', quantity: '1' }),
      expect.objectContaining({ makerOrderId: 'ask-1', price: '101', quantity: '1' }),
    ]);
  });

  it('keeps FIFO order inside the same price level', () => {
    const engine = new MatchingEngine();
    engine.apply(limit('ask-first', 'maker-1', 'SELL', '100', '1'));
    engine.apply(limit('ask-second', 'maker-2', 'SELL', '100', '1'));
    const trades = engine
      .apply(limit('bid', 'taker', 'BUY', '100', '1'))
      .filter((event) => event.kind === 'TRADE_EXECUTED');

    expect(trades[0]).toEqual(expect.objectContaining({ makerOrderId: 'ask-first' }));
  });

  it('returns no trade for an empty market book and cancels the remainder', () => {
    const events = new MatchingEngine().apply(market('market-empty', 'buyer', 'BUY', '1'));

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'ORDER_ACCEPTED', remainingQuantity: '1' }),
        expect.objectContaining({ kind: 'ORDER_CANCELLED', remainingQuantity: '1' }),
      ]),
    );
  });

  it('supports exact, partial and full fills with active remainder', () => {
    const engine = new MatchingEngine();
    engine.apply(limit('ask', 'seller', 'SELL', '100', '3'));
    const events = engine.apply(limit('bid', 'buyer', 'BUY', '100', '5'));

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'TRADE_EXECUTED', quantity: '3' }),
        expect.objectContaining({
          kind: 'ORDER_ACCEPTED',
          status: 'PARTIALLY_FILLED',
          remainingQuantity: '2',
        }),
      ]),
    );
    expect(engine.getActiveOrders()).toEqual([
      expect.objectContaining({ orderId: 'bid', remainingQuantity: quantity('2') }),
    ]);
  });

  it('supports market order remainder, IOC and FOK', () => {
    const engine = new MatchingEngine();
    engine.apply(limit('ask', 'seller', 'SELL', '100', '1'));
    const marketEvents = engine.apply(market('market', 'buyer', 'BUY', '2'));
    expect(marketEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'TRADE_EXECUTED', quantity: '1' }),
        expect.objectContaining({ kind: 'ORDER_CANCELLED', remainingQuantity: '1' }),
      ]),
    );
    expect(engine.apply(market('fok', 'buyer-2', 'BUY', '1', 'FOK')).at(-1)).toEqual(
      expect.objectContaining({ kind: 'ORDER_REJECTED', code: 'FOK_NOT_FILLED' }),
    );
  });

  it('cancels before match and rejects self-trade', () => {
    const engine = new MatchingEngine();
    engine.apply(limit('ask', 'user', 'SELL', '100', '1'));
    expect(engine.apply({ type: 'CANCEL', orderId: 'ask' })).toEqual([
      expect.objectContaining({ kind: 'ORDER_CANCELLED' }),
    ]);
    engine.apply(limit('ask-2', 'user', 'SELL', '100', '1'));
    expect(engine.apply(limit('bid', 'user', 'BUY', '100', '1'))).toEqual([
      expect.objectContaining({ kind: 'ORDER_REJECTED', code: 'SELF_TRADE' }),
    ]);
  });

  it('rejects invalid order shapes and cancel after match', () => {
    const engine = new MatchingEngine();
    expect(
      engine.apply({
        type: 'PLACE',
        orderId: 'bad',
        userId: 'u',
        side: 'BUY',
        orderType: 'LIMIT',
        quantity: quantity('1'),
        timeInForce: 'GTC',
      }),
    ).toEqual([expect.objectContaining({ code: 'LIMIT_PRICE_REQUIRED' })]);
    engine.apply(limit('ask', 'seller', 'SELL', '100', '1'));
    engine.apply(limit('bid', 'buyer', 'BUY', '100', '1'));
    expect(engine.apply({ type: 'CANCEL', orderId: 'bid' })).toEqual([
      expect.objectContaining({ code: 'ORDER_NOT_FOUND' }),
    ]);
  });

  it('produces deterministic replay for generated command sequences', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 1, max: 5 }), { maxLength: 20 }), (values) => {
        const commands = values.map((value, index) =>
          limit(
            `order-${index}`,
            `user-${index % 2}`,
            index % 2 === 0 ? 'BUY' : 'SELL',
            String(100 + value),
            '1',
          ),
        );
        const run = (): readonly unknown[] => {
          const engine = new MatchingEngine();
          return commands.flatMap((command) => engine.apply(command));
        };
        expect(run()).toEqual(run());
      }),
    );
  });
});
