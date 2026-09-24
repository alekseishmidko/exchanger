import { z } from 'zod';

const email = z.string().trim().email().max(254);
const password = z
  .string()
  .min(12)
  .max(256)
  .refine(
    (value) => /[a-z]/i.test(value) && /\d|[^a-z]/i.test(value),
    'password policy not satisfied',
  );
export const registerSchema = z
  .object({ email, password, name: z.string().trim().min(1).max(120) })
  .strict();
export const loginSchema = z
  .object({
    email,
    password: z.string().min(1).max(256),
    deviceLabel: z.string().trim().min(1).max(80).optional(),
  })
  .strict();
export const updateProfileSchema = z.object({ name: z.string().trim().min(1).max(120) }).strict();
export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(256),
    newPassword: password,
    logoutOtherSessions: z.boolean().default(true),
  })
  .strict();
export const challengeSchema = z.object({ email }).strict();
export const verifyEmailSchema = z.object({ token: z.string().min(32).max(256) }).strict();
export const resetPasswordSchema = z
  .object({ token: z.string().min(32).max(256), newPassword: password })
  .strict();
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
