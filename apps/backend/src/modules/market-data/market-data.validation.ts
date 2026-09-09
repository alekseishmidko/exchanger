import { z } from 'zod';

/** Безопасный request/correlation ID WebSocket-команды. */
const requestId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);
/** Ограниченный identifier инструмента или пользователя. */
const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

/**
 * Strict runtime-схема subscribe/unsubscribe.
 *
 * Refinement запрещает смешивать public и private routing fields: это исключает
 * ambiguous subscription, которую разные версии клиента могли бы трактовать
 * по-разному.
 */
export const subscriptionSchema = z
  .object({
    requestId,
    channel: z.enum(['book', 'trades', 'ticker', 'user']),
    instrumentId: identifier.optional(),
    userId: identifier.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.channel === 'user' && (!value.userId || value.instrumentId)) {
      context.addIssue({ code: 'custom', message: 'Private channel requires only userId' });
    }
    if (value.channel !== 'user' && (!value.instrumentId || value.userId)) {
      context.addIssue({ code: 'custom', message: 'Public channel requires only instrumentId' });
    }
  });

/** Strict runtime-схема gap recovery command. */
export const resyncSchema = z
  .object({
    requestId,
    instrumentId: identifier,
    lastSequence: z.number().int().nonnegative(),
  })
  .strict();

/** Strict runtime-схема heartbeat; sentAt нужен только для измерения RTT клиента. */
export const heartbeatSchema = z
  .object({ requestId, sentAt: z.string().datetime().optional() })
  .strict();

/** Точный decimal wire-format без JSON floating point и exponent notation. */
const decimal = z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/);
/** Публичный уровень стакана; дополнительные engine-поля запрещены. */
const bookLevelSchema = z.object({ price: decimal, quantity: decimal }).strict();

/** Runtime-схема snapshot, отправляемого WebSocket-клиенту. */
export const orderBookSnapshotSchema = z
  .object({
    channel: z.literal('book'),
    instrumentId: identifier,
    sequence: z.number().int().nonnegative(),
    bids: z.array(bookLevelSchema),
    asks: z.array(bookLevelSchema),
  })
  .strict();

/** Runtime-схема ordered book increment. */
export const orderBookIncrementSchema = z
  .object({
    channel: z.literal('book_update'),
    instrumentId: identifier,
    sequence: z.number().int().positive(),
    bids: z.array(bookLevelSchema),
    asks: z.array(bookLevelSchema),
  })
  .strict();

/** Runtime-схема trade/ticker без внутренних matching-engine полей. */
export const marketTickSchema = z
  .object({
    channel: z.enum(['trades', 'ticker']),
    instrumentId: identifier,
    sequence: z.number().int().positive(),
    price: decimal,
    quantity: decimal,
  })
  .strict();

/**
 * Runtime-схема private event.
 *
 * Payload разрешает только плоские JSON scalars. Поэтому transport не может
 * случайно сериализовать domain aggregate, массив проводок или вложенный ledger
 * object, даже если producer нарушил compile-time тип.
 */
export const privateUserEventSchema = z
  .object({
    channel: z.literal('user'),
    userId: identifier,
    sequence: z.number().int().positive(),
    type: identifier,
    payload: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])),
  })
  .strict();

/** Allow-list всех сообщений, которые WebSocket adapter вправе отправить. */
export const marketDataMessageSchema = z.union([
  orderBookSnapshotSchema,
  orderBookIncrementSchema,
  marketTickSchema,
  privateUserEventSchema,
]);
