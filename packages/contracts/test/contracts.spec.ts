import {
  domainEventSchema,
  placeOrderCommandSchema,
} from '../src/index';

const envelope = {
  messageId: 'message-1',
  messageVersion: 1,
  occurredAt: '2026-08-29T00:00:00.000Z',
  receivedAt: '2026-08-29T00:00:00.000Z',
  sequence: '1',
  partitionKey: 'BTC-USD',
  correlationId: 'correlation-1',
  causationId: null,
  producer: 'test',
};

describe('contracts', () => {
  it('accepts a valid place order command', () => {
    expect(
      placeOrderCommandSchema.parse({
        ...envelope,
        messageType: 'PlaceOrder',
        payload: {
          commandId: 'command-1',
          orderId: 'order-1',
          userId: 'user-1',
          accountId: 'account-1',
          instrumentId: 'BTC-USD',
          clientOrderId: 'client-order-1',
          side: 'BUY',
          orderType: 'LIMIT',
          quantity: '0.10',
          limitPrice: '50000.00',
          timeInForce: 'GTC',
          feePolicyVersion: 'v1',
          riskPolicyVersion: 'v1',
        },
      }),
    ).toBeTruthy();
  });

  it('rejects floating-point numbers in money fields', () => {
    expect(() =>
      placeOrderCommandSchema.parse({
        ...envelope,
        messageType: 'PlaceOrder',
        payload: {
          commandId: 'command-1',
          orderId: 'order-1',
          userId: 'user-1',
          accountId: 'account-1',
          instrumentId: 'BTC-USD',
          clientOrderId: 'client-order-1',
          side: 'BUY',
          orderType: 'LIMIT',
          quantity: 0.1,
          limitPrice: '50000.00',
          timeInForce: 'GTC',
          feePolicyVersion: 'v1',
          riskPolicyVersion: 'v1',
        },
      }),
    ).toThrow();
  });

  it('accepts a trade event with explicit financial results', () => {
    expect(
      domainEventSchema.parse({
        ...envelope,
        messageType: 'TradeExecuted',
        payload: {
          tradeId: 'trade-1',
          instrumentId: 'BTC-USD',
          makerOrderId: 'order-maker',
          takerOrderId: 'order-taker',
          makerUserId: 'user-maker',
          takerUserId: 'user-taker',
          quantity: '0.10',
          price: '50000.00',
          makerFee: '5.00',
          takerFee: '10.00',
          feeAsset: 'USD',
        },
      }),
    ).toBeTruthy();
  });
});
