/**
 * Runtime schemas human-auth transport.
 * Все object schemas strict: лишние role/security/system fields отклоняются до
 * application service, а bounded strings ограничивают память и KDF workload.
 */
import { z } from 'zod';

/** Общая bounded email wire-validation; canonical normalization выполняет service. */
const email = z.string().trim().email().max(254);
/** Password policy для нового credential; login принимает legacy value и проверяет hash. */
const password = z
  .string()
  .min(12)
  .max(256)
  .refine(
    (value) => /[a-z]/i.test(value) && /\d|[^a-z]/i.test(value),
    'password policy not satisfied',
  );
/** Регистрация разрешает только email, password и display name. */
export const registerSchema = z
  .object({ email, password, name: z.string().trim().min(1).max(120) })
  .strict();
/** Login ограничивает payload и optional device label до безопасной длины. */
export const loginSchema = z
  .object({
    email,
    password: z.string().min(1).max(256),
    deviceLabel: z.string().trim().min(1).max(80).optional(),
  })
  .strict();
/** Self-service profile не позволяет передать roles/scopes/security flags. */
export const updateProfileSchema = z.object({ name: z.string().trim().min(1).max(120) }).strict();
/** Password rotation требует current credential и явную session revocation policy. */
export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(256),
    newPassword: password,
    logoutOtherSessions: z.boolean().default(true),
  })
  .strict();
/** Recovery request принимает только email, сохраняя enumeration-neutral contract. */
export const challengeSchema = z.object({ email }).strict();
/** One-time verification token имеет bounded wire representation. */
export const verifyEmailSchema = z.object({ token: z.string().min(32).max(256) }).strict();
/** Reset confirmation связывает одноразовый token с новым policy-compliant password. */
export const resetPasswordSchema = z
  .object({ token: z.string().min(32).max(256), newPassword: password })
  .strict();
/** Admin session mutation требует audit reason и отклоняет произвольные поля. */
export const adminActionSchema = z
  .object({
    reason: z.enum([
      'security_incident',
      'user_request',
      'credential_compromise',
      'policy_enforcement',
    ]),
  })
  .strict();
