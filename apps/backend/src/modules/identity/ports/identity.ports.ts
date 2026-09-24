import type { SessionRecord, UserRecord } from '../domain/identity.types';

/** DI-токен durable user/credential repository. */
export const USER_STORE = Symbol('USER_STORE');
/** DI-токен Redis-backed source of truth активных human sessions. */
export const SESSION_STORE = Symbol('SESSION_STORE');
/** DI-токен доверенной доставки одноразовых recovery credentials. */
export const RECOVERY_DELIVERY = Symbol('RECOVERY_DELIVERY');

/**
 * Repository пользователей и одноразовых recovery challenges.
 * Реализация обязана обеспечивать case-insensitive uniqueness email и хранить
 * только digest verification/reset token с bounded expiry и one-time consume.
 */
export interface UserStore {
  create(
    input: Readonly<{ emailNormalized: string; name: string; passwordHash: string }>,
  ): Promise<UserRecord>;
  findByEmail(emailNormalized: string): Promise<UserRecord | null>;
  findById(userId: string): Promise<UserRecord | null>;
  updateName(userId: string, name: string): Promise<UserRecord>;
  updatePassword(userId: string, passwordHash: string, requireReset?: boolean): Promise<UserRecord>;
  issueChallenge(
    input: Readonly<{
      userId: string;
      kind: 'EMAIL_VERIFY' | 'PASSWORD_RESET';
      digest: string;
      expiresAt: string;
    }>,
  ): Promise<void>;
  consumeChallenge(
    kind: 'EMAIL_VERIFY' | 'PASSWORD_RESET',
    digest: string,
  ): Promise<UserRecord | null>;
  markEmailVerified(userId: string): Promise<UserRecord>;
}

/**
 * Source of truth сессий. Token передаётся уже как HMAC digest; raw credential
 * никогда не входит в interface и поэтому не может случайно попасть в adapter log.
 */
export interface SessionStore {
  create(tokenDigest: string, session: SessionRecord, ttlSeconds: number): Promise<void>;
  findByTokenDigest(tokenDigest: string): Promise<SessionRecord | null>;
  touch(tokenDigest: string, session: SessionRecord, ttlSeconds: number): Promise<void>;
  listByUser(userId: string): Promise<readonly SessionRecord[]>;
  revoke(userId: string, sessionId: string, revokedAt: string): Promise<boolean>;
  revokeAll(userId: string, revokedAt: string, exceptSessionId?: string): Promise<number>;
  trimToLimit(userId: string, maximum: number, revokedAt: string): Promise<number>;
  check(): Promise<void>;
}

/** Передаёт raw challenge только доверенному mail boundary и не сохраняет его. */
export interface RecoveryDelivery {
  deliver(
    input: Readonly<{
      kind: 'EMAIL_VERIFY' | 'PASSWORD_RESET';
      email: string;
      token: string;
      expiresAt: string;
    }>,
  ): Promise<void>;
}
