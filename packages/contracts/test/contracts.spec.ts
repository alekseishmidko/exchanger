import {
  cancelOrderCommandSchema,
  commandSchema,
  decimalSchema,
  domainEventSchema,
  orderAcceptedEventSchema,
  orderCancelledEventSchema,
  orderRejectedEventSchema,
  placeOrderCommandSchema,
  settlementAppliedEventSchema,
  timestampSchema,
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

/** Детерминированный генератор для property-like contract cases без внешнего state. */
function* seededCases(
  seed: number,
  count: number,
): Generator<{
  sequence: number;
  side: 'BUY' | 'SELL';
  timeInForce: 'GTC' | 'IOC' | 'FOK';
}> {
  let state = seed;
  const tifs = ['GTC', 'IOC', 'FOK'] as const;
  for (let index = 0; index < count; index += 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    yield {
      sequence: (state % 10_000) + 1,
      side: state % 2 === 0 ? 'BUY' : 'SELL',
      timeInForce: tifs[state % tifs.length] ?? 'GTC',
    };
  }
}

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

  it('runs seeded property checks for command and event envelopes', () => {
    for (const { sequence, side, timeInForce } of seededCases(18_001, 64)) {
      const candidate = {
        ...placeOrder,
        messageId: `message-${sequence}`,
        sequence: String(sequence),
        payload: {
          ...placeOrder.payload,
          commandId: `command-${sequence}`,
          orderId: `order-${sequence}`,
          side,
          timeInForce,
          quantity: `${sequence}.01`,
        },
      };
      expect(commandSchema.parse(candidate)).toEqual(candidate);
      expect(
        domainEventSchema.parse({
          ...envelope,
          messageId: `event-message-${sequence}`,
          messageType: 'OrderAccepted',
          sequence: String(sequence),
          payload: {
            orderId: `order-${sequence}`,
            userId: 'user-1',
            accountId: 'account-1',
            instrumentId: 'BTC-USD',
            side,
            quantity: `${sequence}.01`,
            remainingQuantity: '0',
          },
        }),
      ).toBeTruthy();
    }
  });

  it('rejects adversarial identifiers and unknown message versions by policy', () => {
    for (const id of ['order\u0000', 'order\n1', 'order 1', 'оrder-1', 'order/1']) {
      expect(() =>
        placeOrderCommandSchema.parse({
          ...placeOrder,
          payload: { ...placeOrder.payload, orderId: id },
        }),
      ).toThrow();
    }
    expect(() => commandSchema.parse({ ...placeOrder, messageVersion: 999 })).toThrow();
  });

  it('covers decimal and timestamp adversarial boundaries', () => {
    for (const valid of ['0', '0.000000000000000001', '999999999999999999999.999999999']) {
      expect(decimalSchema.parse(valid)).toBe(valid);
    }
    for (const invalid of ['00', '01.00', '1e3', 'NaN', 'Infinity', '-1']) {
      expect(() => decimalSchema.parse(invalid)).toThrow();
    }

    for (const timestamp of [
      '1970-01-01T00:00:00.000Z',
      '2099-12-31T23:59:59.999Z',
      '2026-03-08T01:59:59.000-05:00',
      '2026-11-01T01:30:00.000-04:00',
      '2026-11-01T01:30:00.000-05:00',
    ]) {
      expect(timestampSchema.parse(timestamp)).toBe(timestamp);
    }
    for (const invalid of ['2026-01-01T00:00:00.000', 'not-a-date']) {
      expect(() => timestampSchema.parse(invalid)).toThrow();
    }
  });
});
