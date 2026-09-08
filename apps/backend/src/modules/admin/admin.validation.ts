import { z } from 'zod';

/** Общий строгий формат идентификаторов административного API. */
const identifier = z.string().min(1).max(128);
/** Decimal wire-format запрещает JSON number, exponent и ведущие нули. */
const decimal = z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/);

/** Runtime-схема immutable trading rules без неизвестных полей. */
export const instrumentRulesSchema = z
  .object({
    version: identifier,
    effectiveAt: z.string().datetime(),
    tickSize: decimal,
    lotSize: decimal,
    minQuantity: decimal,
    maxQuantity: decimal,
    minPrice: decimal,
    maxPrice: decimal,
    feePolicyVersion: identifier,
    maxOrderQuantity: decimal,
    maxOpenOrders: z.number().int().positive(),
    maxNotional: decimal,
  })
  .strict();

/** Проверяет CREATE/ADD_RULES и согласованность identity-полей. */
export const configureInstrumentSchema = z
  .object({
    commandId: identifier,
    mode: z.enum(['CREATE', 'ADD_RULES']),
    instrumentId: identifier,
    baseAssetId: identifier.optional(),
    quoteAssetId: identifier.optional(),
    rules: instrumentRulesSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.mode === 'CREATE' && (!value.baseAssetId || !value.quoteAssetId)) {
      context.addIssue({ code: 'custom', message: 'CREATE requires baseAssetId and quoteAssetId' });
    }
    if (value.mode === 'ADD_RULES' && (value.baseAssetId || value.quoteAssetId)) {
      context.addIssue({ code: 'custom', message: 'ADD_RULES forbids asset identity changes' });
    }
  });

/** Runtime-схема lifecycle command. */
export const instrumentStatusSchema = z
  .object({ commandId: identifier, status: z.enum(['ACTIVE', 'PAUSED']) })
  .strict();

/** Runtime-схема freeze/unfreeze command. */
export const freezeSchema = z
  .object({
    commandId: identifier,
    targetType: z.enum(['USER', 'ACCOUNT']),
    targetId: identifier,
    action: z.enum(['FREEZE', 'UNFREEZE']),
  })
  .strict();

/** Runtime-схема circuit breaker command. */
export const circuitBreakerSchema = z
  .object({
    commandId: identifier,
    targetId: z.union([identifier, z.literal('*')]),
    action: z.enum(['STOP', 'RESUME']),
  })
  .strict();

/** Runtime-схема maker/taker fee policy. */
export const feePolicySchema = z
  .object({
    commandId: identifier,
    version: identifier,
    effectiveAt: z.string().datetime(),
    makerRate: decimal,
    takerRate: decimal,
  })
  .strict();

/** Runtime-схема risk policy. */
export const riskPolicySchema = z
  .object({
    commandId: identifier,
    version: identifier,
    effectiveAt: z.string().datetime(),
    maxOrderNotional: decimal,
    maxOpenOrders: z.number().int().positive(),
  })
  .strict();
