import { z } from 'zod';

/** Общий bounded identifier auth command и владельца credential. */
const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

/**
 * Strict wire-схема выпуска API key.
 * Role и owner задаются admin-командой, неизвестные поля отклоняются до registry.
 */
export const issueApiKeySchema = z
  .object({
    commandId: identifier,
    userId: identifier,
    role: z.enum(['trader', 'admin', 'risk_manager', 'auditor', 'support']),
    label: z.string().trim().min(1).max(128),
  })
  .strict();

/**
 * Единая strict схема rotate/revoke. `commandId` участвует в idempotency
 * fingerprint и audit record, но не может подменить path keyId.
 */
export const mutateApiKeySchema = z.object({ commandId: identifier }).strict();
