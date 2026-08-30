import {
  cancelOrderCommandSchema,
  commandSchema,
  domainEventSchema,
  orderAcceptedEventSchema,
  orderCancelledEventSchema,
  orderRejectedEventSchema,
  placeOrderCommandSchema,
  settlementAppliedEventSchema,
  tradeExecutedEventSchema,
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

const placeOrder = {
  ...envelope,
  messageType: 'PlaceOrder' as const,
  payload: {
    commandId: 'command-1',
    orderId: 'order-1',
    userId: 'user-1',
    accountId: 'account-1',
    instrumentId: 'BTC-USD',
    clientOrderId: 'client-order-1',
    side: 'BUY' as const,
    orderType: 'LIMIT' as const,
    quantity: '0.10',
    limitPrice: '50000.00',
    timeInForce: 'GTC' as const,
    feePolicyVersion: 'v1',
    riskPolicyVersion: 'v1',
  },
};

describe('contracts', () => {
  it('accepts PlaceOrder and CancelOrder commands', () => {
    expect(placeOrderCommandSchema.parse(placeOrder)).toEqual(placeOrder);
    expect(
      cancelOrderCommandSchema.parse({
        ...envelope,
        messageType: 'CancelOrder',
        payload: {
          commandId: 'command-2',
          orderId: 'order-1',
          userId: 'user-1',
          accountId: 'account-1',
          instrumentId: 'BTC-USD',
        },
      }),
    ).toBeTruthy();
  });

  it('accepts every declared domain event', () => {
    const orderReference = {
      orderId: 'order-1',
      userId: 'user-1',
      accountId: 'account-1',
      instrumentId: 'BTC-USD',
      side: 'BUY',
    };

    expect(
      orderAcceptedEventSchema.parse({
        ...envelope,
        messageType: 'OrderAccepted',
        payload: { ...orderReference, quantity: '1', remainingQuantity: '1' },
      }),
    ).toBeTruthy();
    expect(
      orderRejectedEventSchema.parse({
        ...envelope,
        messageType: 'OrderRejected',
        payload: { ...orderReference, reasonCode: 'RISK_LIMIT', reasonMessage: 'Rejected' },
      }),
    ).toBeTruthy();
    expect(
      orderCancelledEventSchema.parse({
        ...envelope,
        messageType: 'OrderCancelled',
        payload: { ...orderReference, remainingQuantity: '1', reasonCode: 'USER_REQUEST' },
      }),
    ).toBeTruthy();
    expect(
      tradeExecutedEventSchema.parse({
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
    expect(
      settlementAppliedEventSchema.parse({
        ...envelope,
        messageType: 'SettlementApplied',
        payload: {
          settlementId: 'settlement-1',
          tradeId: 'trade-1',
          instrumentId: 'BTC-USD',
          postings: [
            {
              accountId: 'account-1',
              assetId: 'USD',
              availableDelta: '-10.00',
              reservedDelta: '10.00',
            },
          ],
        },
      }),
    ).toBeTruthy();
  });

  it('accepts unknown optional fields and strips them from the validated contract', () => {
    const parsed = placeOrderCommandSchema.parse({
      ...placeOrder,
      payload: { ...placeOrder.payload, futureOptionalField: 'ignored' },
    });

    expect(parsed.payload).not.toHaveProperty('futureOptionalField');
  });

  it('keeps old message version payloads compatible', () => {
    expect(commandSchema.parse({ ...placeOrder, messageVersion: 1 })).toEqual(placeOrder);
  });

  it('allows duplicate delivery for consumer-side idempotency', () => {
    const first = commandSchema.parse(placeOrder);
    const duplicate = commandSchema.parse({ ...placeOrder });

    expect(duplicate).toEqual(first);
    expect(duplicate.messageId).toBe(first.messageId);
  });

  it('rejects invalid enums, missing metadata and floating-point decimals', () => {
    expect(() => commandSchema.parse({ ...placeOrder, messageType: 'UnknownCommand' })).toThrow();
    expect(() => {
      const { correlationId: _correlationId, ...withoutCorrelationId } = placeOrder;
      commandSchema.parse(withoutCorrelationId);
    }).toThrow();
    expect(() =>
      placeOrderCommandSchema.parse({
        ...placeOrder,
        payload: { ...placeOrder.payload, quantity: 0.1 },
      }),
    ).toThrow();
    expect(() =>
      placeOrderCommandSchema.parse({
        ...placeOrder,
        payload: { ...placeOrder.payload, quantity: '-1' },
      }),
    ).toThrow();
  });

  it('rejects unsupported decimal formats', () => {
    expect(() =>
      placeOrderCommandSchema.parse({
        ...placeOrder,
        payload: { ...placeOrder.payload, quantity: '1e-2' },
      }),
    ).toThrow();
    expect(() =>
      placeOrderCommandSchema.parse({
        ...placeOrder,
        payload: { ...placeOrder.payload, quantity: '01.00' },
      }),
    ).toThrow();
  });

  it('rejects an event with an unknown message type', () => {
    expect(() =>
      domainEventSchema.parse({ ...envelope, messageType: 'UnknownEvent', payload: {} }),
    ).toThrow();
  });
});
