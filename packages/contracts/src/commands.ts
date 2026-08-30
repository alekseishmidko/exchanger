import { z } from 'zod';
import {
  decimalSchema,
  idSchema,
  messageEnvelopeSchema,
  orderTypeSchema,
  sideSchema,
  timeInForceSchema,
} from './common';

/** Схема команды размещения лимитной или рыночной заявки. */
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
/** Тип команды размещения заявки после runtime validation. */
export type PlaceOrderCommand = z.infer<typeof placeOrderCommandSchema>;

/** Схема команды отмены ранее принятой заявки. */
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
/** Тип команды отмены заявки после runtime validation. */
export type CancelOrderCommand = z.infer<typeof cancelOrderCommandSchema>;

/** Discriminated union всех команд межмодульного контракта. */
export const commandSchema = z.discriminatedUnion('messageType', [
  placeOrderCommandSchema,
  cancelOrderCommandSchema,
]);
/** Тип любой команды, поддерживаемой контрактным слоем. */
export type Command = z.infer<typeof commandSchema>;
