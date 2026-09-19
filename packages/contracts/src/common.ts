import { z } from 'zod';

/**
 * Публичный идентификатор сообщения или доменного объекта.
 *
 * Контракт намеренно принимает только bounded ASCII allow-list. Это убирает
 * неоднозначность Unicode normalization, control characters и визуально похожих
 * символов: `order-1` валиден, а `оrder-1` с кириллической `о` отклоняется до
 * попадания в idempotency, ordering или audit boundary.
 */
export const idSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

/** Десятичное значение без floating point и экспоненциальной записи. */
export const decimalSchema = z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/);

/** Знаковая десятичная дельта для проводок и изменений баланса. */
export const signedDecimalSchema = z.string().regex(/^-?(0|[1-9]\d*)(\.\d+)?$/);

/** ISO-8601 timestamp с обязательным указанием часового пояса. */
export const timestampSchema = z.string().datetime({ offset: true });

/**
 * Общий envelope для маршрутизации, корреляции и упорядочивания сообщений.
 *
 * `messageVersion` пока поддерживает только версию `1`. Новая версия должна
 * добавляться явно через compatibility policy и отдельные contract tests, иначе
 * producer с неизвестной схемой будет отклонён до consumer-side effects.
 */
export const messageEnvelopeSchema = z.object({
  messageId: idSchema,
  messageType: z.string().min(1),
  messageVersion: z.literal(1),
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
