import { z } from 'zod';

export const idSchema = z.string().min(1);
export const decimalSchema = z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/);
export const timestampSchema = z.string().datetime({ offset: true });

export const messageEnvelopeSchema = z.object({
  messageId: idSchema,
  messageType: z.string().min(1),
  messageVersion: z.number().int().positive(),
  occurredAt: timestampSchema,
  receivedAt: timestampSchema,
  sequence: z.string().regex(/^[0-9]+$/),
  partitionKey: idSchema,
  correlationId: idSchema,
  causationId: idSchema.nullable(),
  producer: z.string().min(1),
});

export type MessageEnvelope = z.infer<typeof messageEnvelopeSchema>;

export const sideSchema = z.enum(['BUY', 'SELL']);
export type Side = z.infer<typeof sideSchema>;

export const orderTypeSchema = z.enum(['LIMIT', 'MARKET']);
export type OrderType = z.infer<typeof orderTypeSchema>;

export const timeInForceSchema = z.enum(['GTC', 'IOC', 'FOK']);
export type TimeInForce = z.infer<typeof timeInForceSchema>;
