/* eslint-disable @typescript-eslint/require-await -- test adapter keeps async production port contract */
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { SessionRecord, UserRecord } from '../domain/identity.types';
import type { SessionStore, UserStore } from '../ports/identity.ports';

/** Test-only repository; composition root запрещает его вне component profile. */
@Injectable()
export class MemoryUserStore implements UserStore {
  private readonly users = new Map<string, UserRecord>();
  private readonly userIdByEmail = new Map<string, string>();
  private readonly challenges = new Map<
    string,
    { userId: string; expiresAt: string; consumed: boolean }
  >();

  async create(
    input: Readonly<{ emailNormalized: string; name: string; passwordHash: string }>,
  ): Promise<UserRecord> {
    if (this.userIdByEmail.has(input.emailNormalized))
      throw new ConflictException({
        code: 'AUTH_REGISTRATION_FAILED',
        message: 'Registration could not be completed',
      });
    const now = new Date().toISOString();
    const user: UserRecord = {
      id: `usr_${randomUUID()}`,
      ...input,
      roles: ['USER'],
      scopes: ['profile:read', 'profile:write', 'sessions:manage', 'trading:read', 'trading:write'],
      emailVerifiedAt: null,
      passwordResetRequired: false,
      securityVersion: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.users.set(user.id, user);
    this.userIdByEmail.set(user.emailNormalized, user.id);
    return user;
  }

  async findByEmail(emailNormalized: string): Promise<UserRecord | null> {
    const id = this.userIdByEmail.get(emailNormalized);
    return id ? (this.users.get(id) ?? null) : null;
  }

  async findById(userId: string): Promise<UserRecord | null> {
    return this.users.get(userId) ?? null;
  }

  async updateName(userId: string, name: string): Promise<UserRecord> {
    return this.mutate(userId, (user) => ({ ...user, name, updatedAt: new Date().toISOString() }));
  }

  async updatePassword(
    userId: string,
    passwordHash: string,
    requireReset = false,
  ): Promise<UserRecord> {
    return this.mutate(userId, (user) => ({
      ...user,
      passwordHash,
      passwordResetRequired: requireReset,
      securityVersion: user.securityVersion + 1,
      updatedAt: new Date().toISOString(),
    }));
  }

  async rehashPassword(userId: string, previousHash: string, passwordHash: string): Promise<void> {
    const user = this.users.get(userId);
    if (user?.passwordHash === previousHash)
      this.users.set(userId, { ...user, passwordHash, updatedAt: new Date().toISOString() });
  }

  async issueChallenge(
    input: Readonly<{
      userId: string;
      kind: 'EMAIL_VERIFY' | 'PASSWORD_RESET';
      digest: string;
      expiresAt: string;
    }>,
  ): Promise<void> {
    for (const [key, challenge] of this.challenges)
      if (key.startsWith(`${input.kind}:`) && challenge.userId === input.userId)
        challenge.consumed = true;
    this.challenges.set(`${input.kind}:${input.digest}`, {
      userId: input.userId,
      expiresAt: input.expiresAt,
      consumed: false,
    });
  }

  async invalidateChallenge(
    kind: 'EMAIL_VERIFY' | 'PASSWORD_RESET',
    digest: string,
  ): Promise<void> {
    const challenge = this.challenges.get(`${kind}:${digest}`);
    if (challenge) challenge.consumed = true;
  }

  async consumeChallenge(
    kind: 'EMAIL_VERIFY' | 'PASSWORD_RESET',
    digest: string,
  ): Promise<UserRecord | null> {
    const key = `${kind}:${digest}`;
    const challenge = this.challenges.get(key);
    if (!challenge || challenge.consumed || Date.parse(challenge.expiresAt) <= Date.now())
      return null;
    challenge.consumed = true;
    return this.users.get(challenge.userId) ?? null;
  }

  async completePasswordReset(digest: string, passwordHash: string): Promise<UserRecord | null> {
    const user = await this.consumeChallenge('PASSWORD_RESET', digest);
    if (!user) return null;
    for (const [key, challenge] of this.challenges)
      if (key.startsWith('PASSWORD_RESET:') && challenge.userId === user.id)
        challenge.consumed = true;
    return this.updatePassword(user.id, passwordHash);
  }

  async cleanupExpiredChallenges(limit: number): Promise<number> {
    let removed = 0;
    for (const [key, challenge] of this.challenges) {
      if (removed >= limit) break;
      if (challenge.consumed || Date.parse(challenge.expiresAt) <= Date.now()) {
        this.challenges.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  async markEmailVerified(userId: string): Promise<UserRecord> {
    return this.mutate(userId, (user) => ({
      ...user,
      emailVerifiedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
  }

  private mutate(userId: string, operation: (user: UserRecord) => UserRecord): UserRecord {
    const user = this.users.get(userId);
    if (!user)
      throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'User was not found' });
    const updated = operation(user);
    this.users.set(userId, updated);
    return updated;
  }
}

/** Test-only session source of truth с той же revoke/TTL семантикой, что Redis adapter. */
@Injectable()
export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, { digest: string; session: SessionRecord }>();

  async create(tokenDigest: string, session: SessionRecord): Promise<void> {
    this.sessions.set(session.sessionId, { digest: tokenDigest, session });
  }

  async findByTokenDigest(tokenDigest: string): Promise<SessionRecord | null> {
    const found = [...this.sessions.values()].find((item) => item.digest === tokenDigest)?.session;
    if (!found || found.revokedAt || Date.parse(found.expiresAt) <= Date.now()) return null;
    return found;
  }

  async touch(tokenDigest: string, session: SessionRecord): Promise<boolean> {
    const current = this.sessions.get(session.sessionId);
    if (
      !current ||
      current.digest !== tokenDigest ||
      current.session.revokedAt ||
      current.session.securityVersion !== session.securityVersion
    )
      return false;
    this.sessions.set(session.sessionId, { digest: tokenDigest, session });
    return true;
  }

  async listByUser(userId: string): Promise<readonly SessionRecord[]> {
    return [...this.sessions.values()]
      .map((item) => item.session)
      .filter((session) => session.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async revoke(userId: string, sessionId: string, revokedAt: string): Promise<boolean> {
    const found = this.sessions.get(sessionId);
    if (!found || found.session.userId !== userId || found.session.revokedAt) return false;
    this.sessions.set(sessionId, { ...found, session: { ...found.session, revokedAt } });
    return true;
  }

  async revokeAll(userId: string, revokedAt: string, exceptSessionId?: string): Promise<number> {
    let count = 0;
    for (const session of await this.listByUser(userId)) {
      if (
        session.sessionId !== exceptSessionId &&
        (await this.revoke(userId, session.sessionId, revokedAt))
      )
        count += 1;
    }
    return count;
  }

  async trimToLimit(userId: string, maximum: number, revokedAt: string): Promise<number> {
    const active = (await this.listByUser(userId)).filter((item) => !item.revokedAt);
    let count = 0;
    for (const session of active.slice(maximum))
      if (await this.revoke(userId, session.sessionId, revokedAt)) count += 1;
    return count;
  }

  async check(): Promise<void> {}
}
