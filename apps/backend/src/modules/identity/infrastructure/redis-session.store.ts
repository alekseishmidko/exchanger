import {
  Injectable,
  OnApplicationShutdown,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient } from 'redis';
import { createHmac } from 'node:crypto';
import type { SessionRecord } from '../domain/identity.types';
import type { SessionStore } from '../ports/identity.ports';

/**
 * Redis source of truth human sessions.
 *
 * Ключи содержат только namespace и HMAC/digest identifiers; email, accountId и
 * raw token отсутствуют. Каждая запись имеет Redis TTL не длиннее absolute TTL.
 * Операции ограничены timeout-ом клиента, auto-pipelining и bounded reconnect,
 * а outage возвращает безопасный 503/делает readiness unavailable.
 */
@Injectable()
export class RedisSessionStore implements SessionStore, OnModuleInit, OnApplicationShutdown {
  private readonly client;
  private readonly namespace: string;
  private readonly maxValueBytes: number;
  private readonly keySecret: string;
  private readonly indexTtlSeconds: number;

  constructor(config: ConfigService) {
    this.namespace = config.get('AUTH_REDIS_NAMESPACE', 'exchange:identity:v1');
    this.maxValueBytes = Number(config.get('AUTH_SESSION_MAX_VALUE_BYTES', '8192'));
    this.keySecret = config.getOrThrow('AUTH_TOKEN_HASH_SECRET');
    this.indexTtlSeconds = Number(config.get('AUTH_SESSION_ABSOLUTE_TTL_SECONDS', '604800'));
    this.client = createClient({
      url: config.getOrThrow<string>('AUTH_REDIS_URL'),
      socket: {
        connectTimeout: Number(config.get('AUTH_REDIS_CONNECT_TIMEOUT_MS', '1000')),
        reconnectStrategy: (retries) =>
          retries >= 5
            ? new Error('AUTH_REDIS_RECONNECT_BUDGET_EXHAUSTED')
            : Math.min(50 * 2 ** retries, 1000),
      },
      disableOfflineQueue: true,
    });
    this.client.on('error', () => undefined);
  }

  /** Подключается при startup; production не начинает admission без Redis. */
  async onModuleInit(): Promise<void> {
    await this.client.connect();
  }
  /** Закрывает sockets без публикации connection string. */
  onApplicationShutdown(): Promise<void> {
    if (this.client.isOpen) this.client.destroy();
    return Promise.resolve();
  }

  async create(tokenDigest: string, session: SessionRecord, ttlSeconds: number): Promise<void> {
    await this.write(tokenDigest, session, ttlSeconds, true);
  }

  async findByTokenDigest(tokenDigest: string): Promise<SessionRecord | null> {
    try {
      const value = await this.client.get(this.tokenKey(tokenDigest));
      if (!value || Buffer.byteLength(value) > this.maxValueBytes) return null;
      const session = this.parse(value);
      return session.revokedAt ? null : session;
    } catch {
      throw this.unavailable();
    }
  }

  async touch(tokenDigest: string, session: SessionRecord, ttlSeconds: number): Promise<void> {
    await this.write(tokenDigest, session, ttlSeconds, false);
  }

  async listByUser(userId: string): Promise<readonly SessionRecord[]> {
    try {
      const ids = await this.client.sMembers(this.userKey(userId));
      if (ids.length === 0) return [];
      const values = await this.client.mGet(ids.map((id) => this.sessionKey(id)));
      return values
        .filter((value): value is string => Boolean(value))
        .map((value) => this.parse(value))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    } catch {
      throw this.unavailable();
    }
  }

  async revoke(userId: string, sessionId: string, revokedAt: string): Promise<boolean> {
    const session = (await this.listByUser(userId)).find((item) => item.sessionId === sessionId);
    if (!session || session.revokedAt) return false;
    const ttl = Math.max(1, Math.ceil((Date.parse(session.absoluteExpiresAt) - Date.now()) / 1000));
    const serialized = this.serialize({ ...session, revokedAt });
    try {
      await this.client
        .multi()
        .set(this.sessionKey(sessionId), serialized, { EX: ttl })
        .set(this.tokenKey(this.tokenDigestFromRecord(session)), serialized, { EX: ttl })
        .exec();
      return true;
    } catch {
      throw this.unavailable();
    }
  }

  async revokeAll(userId: string, revokedAt: string, exceptSessionId?: string): Promise<number> {
    let count = 0;
    for (const session of await this.listByUser(userId))
      if (
        session.sessionId !== exceptSessionId &&
        (await this.revoke(userId, session.sessionId, revokedAt))
      )
        count += 1;
    return count;
  }

  async trimToLimit(userId: string, maximum: number, revokedAt: string): Promise<number> {
    const active = (await this.listByUser(userId)).filter((item) => !item.revokedAt);
    let count = 0;
    for (const session of active.slice(maximum))
      if (await this.revoke(userId, session.sessionId, revokedAt)) count += 1;
    return count;
  }

  async check(): Promise<void> {
    try {
      if ((await this.client.ping()) !== 'PONG') throw new Error('PING_FAILED');
    } catch {
      throw this.unavailable();
    }
  }

  private async write(
    tokenDigest: string,
    session: SessionRecord,
    ttlSeconds: number,
    addIndex: boolean,
  ): Promise<void> {
    const value = this.serialize({
      ...session,
      correlation: { ...session.correlation, tokenDigest },
    } as SessionRecord);
    try {
      const transaction = this.client
        .multi()
        .set(this.tokenKey(tokenDigest), value, { EX: ttlSeconds })
        .set(this.sessionKey(session.sessionId), value, { EX: ttlSeconds });
      if (addIndex)
        transaction
          .sAdd(this.userKey(session.userId), session.sessionId)
          .expire(this.userKey(session.userId), Math.max(ttlSeconds, this.indexTtlSeconds));
      await transaction.exec();
    } catch {
      throw this.unavailable();
    }
  }

  private tokenDigestFromRecord(session: SessionRecord): string {
    const value = (session.correlation as Record<string, string>)['tokenDigest'];
    if (!value) throw new Error('SESSION_TOKEN_DIGEST_MISSING');
    return value;
  }
  private tokenKey(digest: string): string {
    return `${this.namespace}:token:${digest}`;
  }
  private sessionKey(id: string): string {
    return `${this.namespace}:session:${this.keyDigest(id)}`;
  }
  private userKey(userId: string): string {
    return `${this.namespace}:user:${this.keyDigest(userId)}`;
  }
  private keyDigest(value: string): string {
    return createHmac('sha256', this.keySecret)
      .update(`redis-key\u0000${value}`)
      .digest('base64url');
  }
  private serialize(session: SessionRecord): string {
    const value = JSON.stringify(session);
    if (Buffer.byteLength(value) > this.maxValueBytes) throw new Error('SESSION_VALUE_TOO_LARGE');
    return value;
  }
  private parse(value: string): SessionRecord {
    return JSON.parse(value) as SessionRecord;
  }
  private unavailable(): ServiceUnavailableException {
    return new ServiceUnavailableException({
      code: 'AUTH_SESSION_STORE_UNAVAILABLE',
      message: 'Authentication is temporarily unavailable',
    });
  }
}
