import { Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { createClient } from 'redis';
import type { AuthenticatedSocket } from '../transport/market-data.gateway.types';

/**
 * Управляет распределёнными лимитами WebSocket-подключений и сообщений.
 *
 * В production каждый IP и authenticated principal получает bounded bucket в
 * Redis. Команды исполняются без offline queue и с единым deadline; при ошибке
 * Redis admission закрывается. Process-local режим разрешён только component
 * profile и нужен для изолированных тестов без внешней инфраструктуры.
 *
 * Инварианты:
 * - исходные IP, principal id и socket id не записываются в Redis;
 * - каждый успешно занятый connection slot освобождается не более одного раза;
 * - превышение message limit и недоступность Redis закрывают socket;
 * - Redis keys имеют фиксированный namespace и ограниченный TTL.
 *
 * @example
 * ```ts
 * if (!(await abuseControl.admitIp(socket))) socket.disconnect(true);
 * if (!(await abuseControl.admitPrincipal(socket, principal.userId))) {
 *   abuseControl.release(socket);
 * }
 * ```
 */
@Injectable()
export class MarketDataAbuseControl implements OnModuleInit, OnApplicationShutdown {
  private readonly connectionCounts = new Map<string, number>();
  private readonly connectionBuckets = new Map<string, string[]>();
  private readonly messageWindows = new Map<string, { startedAt: number; count: number }>();
  private readonly maxConnectionsPerBucket: number;
  private readonly maxMessagesPerWindow: number;
  private readonly messageWindowMs: number;
  private readonly redisClient;
  private readonly namespace: string;
  private readonly commandTimeoutMs: number;
  private readonly digestKey: string;

  /** Создаёт fail-closed Redis adapter или component-only local adapter. */
  constructor(config: ConfigService) {
    this.maxConnectionsPerBucket = Number(config.get('WEBSOCKET_MAX_CONNECTIONS_PER_IP', 20));
    this.maxMessagesPerWindow = Number(config.get('WEBSOCKET_MAX_MESSAGES_PER_WINDOW', 120));
    this.messageWindowMs = Number(config.get('WEBSOCKET_MESSAGE_WINDOW_MS', 60_000));
    this.namespace = config.get('AUTH_REDIS_NAMESPACE', 'exchange:identity:v1');
    this.commandTimeoutMs = Number(config.get('AUTH_REDIS_COMMAND_TIMEOUT_MS', '750'));
    this.digestKey = config.get('AUTH_TOKEN_HASH_SECRET', 'component-test-digest-key');
    this.redisClient =
      config.get('RUNTIME_PROFILE') === 'component'
        ? null
        : createClient({
            url: config.getOrThrow<string>('AUTH_REDIS_URL'),
            socket: {
              connectTimeout: Number(config.get('AUTH_REDIS_CONNECT_TIMEOUT_MS', '1000')),
              reconnectStrategy: false,
            },
            disableOfflineQueue: true,
          });
    this.redisClient?.on('error', () => undefined);
  }

  /** Подключает least-purpose Redis client до начала WebSocket admission. */
  async onModuleInit(): Promise<void> {
    if (this.redisClient) await this.redisClient.connect();
  }

  /** Закрывает Redis client при остановке приложения. */
  onApplicationShutdown(): Promise<void> {
    this.redisClient?.destroy();
    return Promise.resolve();
  }

  /** Резервирует connection slot по HMAC-digest transport address. */
  admitIp(client: AuthenticatedSocket): Promise<boolean> {
    return this.admitBucket(client, `ip:${this.digest(client.handshake.address || 'unknown')}`);
  }

  /** Резервирует второй connection slot по HMAC-digest authenticated principal. */
  admitPrincipal(client: AuthenticatedSocket, principalId: string): Promise<boolean> {
    return this.admitBucket(client, `principal:${this.digest(principalId)}`);
  }

  /**
   * Продлевает leases уже занятых connection buckets.
   * Отсутствующий или истёкший bucket намеренно не восстанавливается.
   */
  async renew(client: AuthenticatedSocket, credentialRecheckMs: number): Promise<void> {
    if (!this.redisClient) return;
    const buckets = this.connectionBuckets.get(client.id) ?? [];
    await this.withDeadline(
      this.redisClient.eval(
        `for _, key in ipairs(KEYS) do if redis.call('EXISTS', key) == 1 then redis.call('PEXPIRE', key, ARGV[1]) end end return 1`,
        {
          keys: buckets.map((bucket) => `${this.namespace}:ws:connections:${bucket}`),
          arguments: [String(Math.max(this.messageWindowMs * 2, credentialRecheckMs * 3))],
        },
      ),
    );
  }

  /** Идемпотентно освобождает все IP/principal slots и local message state socket. */
  release(client: AuthenticatedSocket): void {
    this.messageWindows.delete(client.id);
    const buckets = this.connectionBuckets.get(client.id);
    if (!buckets) return;
    this.connectionBuckets.delete(client.id);
    if (this.redisClient) {
      for (const bucket of buckets)
        void this.withDeadline(
          this.redisClient.eval(
            `local value = tonumber(redis.call('GET', KEYS[1]) or '0'); if value <= 1 then redis.call('DEL', KEYS[1]); return 0 end; return redis.call('DECR', KEYS[1])`,
            { keys: [`${this.namespace}:ws:connections:${bucket}`], arguments: [] },
          ),
        ).catch(() => undefined);
      return;
    }
    for (const bucket of buckets) {
      const count = this.connectionCounts.get(bucket) ?? 1;
      if (count <= 1) this.connectionCounts.delete(bucket);
      else this.connectionCounts.set(bucket, count - 1);
    }
  }

  /** Допускает bounded command rate либо закрывает socket при reject/outage. */
  async admitMessage(client: AuthenticatedSocket, now = Date.now()): Promise<boolean> {
    const buckets = this.connectionBuckets.get(client.id) ?? [`socket:${this.digest(client.id)}`];
    if (this.redisClient) {
      try {
        const count = await this.withDeadline(
          this.redisClient.eval(
            `local maximum = 0; for _, key in ipairs(KEYS) do local value = redis.call('INCR', key); if value == 1 then redis.call('PEXPIRE', key, ARGV[1]) end; if value > maximum then maximum = value end end; return maximum`,
            {
              keys: buckets.map((bucket) => `${this.namespace}:ws:messages:${bucket}`),
              arguments: [String(this.messageWindowMs)],
            },
          ),
        );
        if (Number(count) <= this.maxMessagesPerWindow) return true;
      } catch {
        // Dependency outage is fail-closed for WebSocket admission.
      }
      client.disconnect(true);
      return false;
    }
    const previous = this.messageWindows.get(client.id);
    const window =
      !previous || now - previous.startedAt >= this.messageWindowMs
        ? { startedAt: now, count: 0 }
        : previous;
    window.count += 1;
    this.messageWindows.set(client.id, window);
    if (window.count <= this.maxMessagesPerWindow) return true;
    client.disconnect(true);
    return false;
  }

  /** Атомарно занимает один distributed/local connection slot. */
  private async admitBucket(client: AuthenticatedSocket, bucket: string): Promise<boolean> {
    if (this.redisClient) {
      const script = `
        local count = redis.call('INCR', KEYS[1])
        if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
        if count > tonumber(ARGV[1]) then
          redis.call('DECR', KEYS[1])
          return 0
        end
        return 1
      `;
      try {
        const allowed = await this.withDeadline(
          this.redisClient.eval(script, {
            keys: [`${this.namespace}:ws:connections:${bucket}`],
            arguments: [String(this.maxConnectionsPerBucket), String(this.messageWindowMs * 2)],
          }),
        );
        if (Number(allowed) !== 1) return false;
        this.rememberBucket(client.id, bucket);
        return true;
      } catch {
        return false;
      }
    }
    const count = this.connectionCounts.get(bucket) ?? 0;
    if (count >= this.maxConnectionsPerBucket) return false;
    this.connectionCounts.set(bucket, count + 1);
    this.rememberBucket(client.id, bucket);
    return true;
  }

  /** Связывает занятый bucket с socket для renew/release. */
  private rememberBucket(socketId: string, bucket: string): void {
    this.connectionBuckets.set(socketId, [...(this.connectionBuckets.get(socketId) ?? []), bucket]);
  }

  /** HMAC скрывает PII-derived bucket от offline dictionary inspection. */
  private digest(value: string): string {
    return createHmac('sha256', this.digestKey).update(value).digest('hex');
  }

  /** Ограничивает Redis command latency единым auth deadline. */
  private async withDeadline<T>(operation: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('WEBSOCKET_ABUSE_REDIS_TIMEOUT')),
            this.commandTimeoutMs,
          );
          timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
