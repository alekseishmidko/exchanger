import { z } from 'zod';

/** Общий безопасный формат transport identifiers. */
const identifier = z.string().min(1).max(128);

/** Runtime-схема создания аккаунта и allow-listed asset definitions. */
export const createAccountSchema = z
  .object({
    commandId: identifier,
    accountId: identifier,
    ownerId: identifier,
    balances: z
      .array(
        z
          .object({
            assetId: identifier,
            code: z.string().regex(/^[A-Z0-9-]+$/),
            scale: z.number().int().min(0).max(18),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();

/** Runtime-схема balance command с decimal string вместо floating point. */
export const changeBalanceSchema = z
  .object({
    commandId: identifier,
    action: z.enum(['CREDIT', 'DEBIT', 'RESERVE', 'RELEASE']),
    amount: z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/),
  })
  .strict();
