import { z } from 'zod';
import {
  decimalSchema,
  idSchema,
  messageEnvelopeSchema,
  orderTypeSchema,
  sideSchema,
  timeInForceSchema,
} from './common';

export const placeOrderCommandSchema = messageEnvelopeSchema.extend({
  messageType: z.literal('PlaceOrder'),
  payload: z.object({
    commandId: idSchema,
    orderId: idSchema,
    userId: idSchema,
    accountId: idSchema,
    instrumentId: idSchema,
    clientOrderId: idSchema,
    side: sideSchema,
    orderType: orderTypeSchema,
    quantity: decimalSchema,
    limitPrice: decimalSchema.nullable(),
    timeInForce: timeInForceSchema,
    feePolicyVersion: z.string().min(1),
    riskPolicyVersion: z.string().min(1),
  }),
});
export type PlaceOrderCommand = z.infer<typeof placeOrderCommandSchema>;

export const cancelOrderCommandSchema = messageEnvelopeSchema.extend({
  messageType: z.literal('CancelOrder'),
  payload: z.object({
    commandId: idSchema,
    orderId: idSchema,
    userId: idSchema,
    accountId: idSchema,
    instrumentId: idSchema,
  }),
});
export type CancelOrderCommand = z.infer<typeof cancelOrderCommandSchema>;

export const commandSchema = z.discriminatedUnion('messageType', [
  placeOrderCommandSchema,
  cancelOrderCommandSchema,
]);
export type Command = z.infer<typeof commandSchema>;
