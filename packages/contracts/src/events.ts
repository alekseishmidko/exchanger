import { z } from 'zod';
import {
  decimalSchema,
  idSchema,
  messageEnvelopeSchema,
  sideSchema,
  signedDecimalSchema,
} from './common';

const orderReferenceSchema = z.object({
  orderId: idSchema,
  userId: idSchema,
  accountId: idSchema,
  instrumentId: idSchema,
  side: sideSchema,
});

/** Событие принятия заявки торговым контуром. */
export const orderAcceptedEventSchema = messageEnvelopeSchema.extend({
  messageType: z.literal('OrderAccepted'),
  payload: orderReferenceSchema.extend({
    quantity: decimalSchema,
    remainingQuantity: decimalSchema,
  }),
});
/** Тип события принятия заявки. */
export type OrderAcceptedEvent = z.infer<typeof orderAcceptedEventSchema>;

/** Событие отклонения заявки с безопасным кодом причины. */
export const orderRejectedEventSchema = messageEnvelopeSchema.extend({
  messageType: z.literal('OrderRejected'),
  payload: orderReferenceSchema.extend({
    reasonCode: z.string().min(1),
    reasonMessage: z.string().min(1),
  }),
});
/** Тип события отклонения заявки. */
export type OrderRejectedEvent = z.infer<typeof orderRejectedEventSchema>;

/** Событие исполнения сделки с итогами по цене, объёму и комиссиям. */
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
/** Тип события исполнения сделки. */
export type TradeExecutedEvent = z.infer<typeof tradeExecutedEventSchema>;

/** Событие применения проводок по исполненной сделке. */
export const settlementAppliedEventSchema = messageEnvelopeSchema.extend({
  messageType: z.literal('SettlementApplied'),
  payload: z.object({
    settlementId: idSchema,
    tradeId: idSchema,
    instrumentId: idSchema,
    postings: z
      .array(
        z.object({
          accountId: idSchema,
          assetId: idSchema,
          availableDelta: signedDecimalSchema,
          reservedDelta: signedDecimalSchema,
        }),
      )
      .min(1),
  }),
});
/** Тип события завершённого settlement. */
export type SettlementAppliedEvent = z.infer<typeof settlementAppliedEventSchema>;

/** Событие отмены заявки с оставшимся объёмом. */
export const orderCancelledEventSchema = messageEnvelopeSchema.extend({
  messageType: z.literal('OrderCancelled'),
  payload: orderReferenceSchema.extend({
    remainingQuantity: decimalSchema,
    reasonCode: z.string().min(1),
  }),
});
/** Тип события отмены заявки. */
export type OrderCancelledEvent = z.infer<typeof orderCancelledEventSchema>;

/** Discriminated union всех событий доменного слоя. */
export const domainEventSchema = z.discriminatedUnion('messageType', [
  orderAcceptedEventSchema,
  orderRejectedEventSchema,
  tradeExecutedEventSchema,
  settlementAppliedEventSchema,
  orderCancelledEventSchema,
]);
/** Тип любого события, поддерживаемого контрактным слоем. */
export type DomainEvent = z.infer<typeof domainEventSchema>;
