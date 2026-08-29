import { z } from 'zod';
import {
  decimalSchema,
  idSchema,
  messageEnvelopeSchema,
  sideSchema,
} from './common';

const orderReferenceSchema = z.object({
  orderId: idSchema,
  userId: idSchema,
  accountId: idSchema,
  instrumentId: idSchema,
  side: sideSchema,
});

export const orderAcceptedEventSchema = messageEnvelopeSchema.extend({
  messageType: z.literal('OrderAccepted'),
  payload: orderReferenceSchema.extend({
    quantity: decimalSchema,
    remainingQuantity: decimalSchema,
  }),
});
export type OrderAcceptedEvent = z.infer<typeof orderAcceptedEventSchema>;

export const orderRejectedEventSchema = messageEnvelopeSchema.extend({
  messageType: z.literal('OrderRejected'),
  payload: orderReferenceSchema.extend({
    reasonCode: z.string().min(1),
    reasonMessage: z.string().min(1),
  }),
});
export type OrderRejectedEvent = z.infer<typeof orderRejectedEventSchema>;

export const tradeExecutedEventSchema = messageEnvelopeSchema.extend({
  messageType: z.literal('TradeExecuted'),
  payload: z.object({
    tradeId: idSchema,
    instrumentId: idSchema,
    makerOrderId: idSchema,
    takerOrderId: idSchema,
    makerUserId: idSchema,
    takerUserId: idSchema,
    quantity: decimalSchema,
    price: decimalSchema,
    makerFee: decimalSchema,
    takerFee: decimalSchema,
    feeAsset: idSchema,
  }),
});
export type TradeExecutedEvent = z.infer<typeof tradeExecutedEventSchema>;

export const settlementAppliedEventSchema = messageEnvelopeSchema.extend({
  messageType: z.literal('SettlementApplied'),
  payload: z.object({
    settlementId: idSchema,
    tradeId: idSchema,
    instrumentId: idSchema,
    postings: z.array(
      z.object({
        accountId: idSchema,
        assetId: idSchema,
        availableDelta: decimalSchema,
        reservedDelta: decimalSchema,
      }),
    ).min(1),
  }),
});
export type SettlementAppliedEvent = z.infer<typeof settlementAppliedEventSchema>;

export const orderCancelledEventSchema = messageEnvelopeSchema.extend({
  messageType: z.literal('OrderCancelled'),
  payload: orderReferenceSchema.extend({
    remainingQuantity: decimalSchema,
    reasonCode: z.string().min(1),
  }),
});
export type OrderCancelledEvent = z.infer<typeof orderCancelledEventSchema>;

export const domainEventSchema = z.discriminatedUnion('messageType', [
  orderAcceptedEventSchema,
  orderRejectedEventSchema,
  tradeExecutedEventSchema,
  settlementAppliedEventSchema,
  orderCancelledEventSchema,
]);
export type DomainEvent = z.infer<typeof domainEventSchema>;
