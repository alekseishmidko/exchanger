import { z } from 'zod';

/** Идентификатор сообщения или доменного объекта, не допускающий пустую строку. */
export const idSchema = z.string().min(1);

/** Десятичное значение без floating point и экспоненциальной записи. */
export const decimalSchema = z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/);

/** Знаковая десятичная дельта для проводок и изменений баланса. */
export const signedDecimalSchema = z.string().regex(/^-?(0|[1-9]\d*)(\.\d+)?$/);

/** ISO-8601 timestamp с обязательным указанием часового пояса. */
export const timestampSchema = z.string().datetime({ offset: true });

/** Общий envelope для маршрутизации, корреляции и упорядочивания сообщений. */
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

/** Типизированное представление общего message envelope. */
export type MessageEnvelope = z.infer<typeof messageEnvelopeSchema>;

/** Сторона заявки в стакане. */
export const sideSchema = z.enum(['BUY', 'SELL']);
export type Side = z.infer<typeof sideSchema>;

/** Тип заявки, поддерживаемый торговым контуром. */
export const orderTypeSchema = z.enum(['LIMIT', 'MARKET']);
export type OrderType = z.infer<typeof orderTypeSchema>;

/** Политика времени жизни заявки. */
export const timeInForceSchema = z.enum(['GTC', 'IOC', 'FOK']);
export type TimeInForce = z.infer<typeof timeInForceSchema>;
