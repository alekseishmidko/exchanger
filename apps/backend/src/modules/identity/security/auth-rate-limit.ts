import {
  HttpException,
  Injectable,
  OnApplicationShutdown,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient } from 'redis';
import { LOG_EVENTS, StructuredLogger } from '../../observability';

/**
 * Distributed fixed-window limiter для password/recovery boundaries.
 * Production хранит bounded buckets в Redis с TTL; component tests используют
 * ограниченный Map, который очищает expired записи и не растёт без верхней границы.
 */
@Injectable()
export class AuthRateLimit implements OnModuleInit, OnApplicationShutdown {
  private readonly windows = new Map<string, { startedAt: number; count: number }>();
  private readonly client;
  private readonly distributed: boolean;
  private readonly namespace: string;
  private readonly commandTimeoutMs: number;

  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly logger?: StructuredLogger,
  ) {
    this.distributed = config.get('RUNTIME_PROFILE') !== 'component';
    this.namespace = config.get('AUTH_REDIS_NAMESPACE', 'exchange:identity:v1');
    this.commandTimeoutMs = Number(config.get('AUTH_REDIS_COMMAND_TIMEOUT_MS', '750'));
    this.client = this.distributed
      ? createClient({
          url: config.getOrThrow<string>('AUTH_REDIS_URL'),
          socket: {
            connectTimeout: Number(config.get('AUTH_REDIS_CONNECT_TIMEOUT_MS', '1000')),
            reconnectStrategy: false,
          },
          disableOfflineQueue: true,
        })
      : null;
    this.client?.on('error', () => undefined);
  }

  /** Подключает shared limiter до admission production traffic. */
  async onModuleInit(): Promise<void> {
    if (this.client) await this.client.connect();
  }

  /** Закрывает отдельное least-purpose Redis connection. */
  onApplicationShutdown(): Promise<void> {
    this.client?.destroy();
    return Promise.resolve();
  }

  /** Проверяет одновременно IP, account и global buckets без PII в Redis key. */
  async check(keys: readonly string[], now = Date.now()): Promise<void> {
    const limit = Number(this.config.get('AUTH_RATE_LIMIT', '10'));
    const globalLimit = Number(this.config.get('AUTH_RATE_GLOBAL_LIMIT', '1000'));
    const duration = Number(this.config.get('AUTH_RATE_WINDOW_MS', '60000'));
    const exceeded = this.client
      ? await this.checkRedis(keys, limit, globalLimit, duration)
      : this.checkMemory(keys, limit, globalLimit, duration, now);
    if (exceeded) {
      this.logger?.warn('identity', LOG_EVENTS.AUTH_RATE_LIMITED, {
        outcome: 'rejected',
        metadata: { policy: 'password-boundary' },
      });
      throw new HttpException(
        { code: 'AUTH_RATE_LIMITED', message: 'Request cannot be completed' },
        429,
      );
    }
  }

  private async checkRedis(
    keys: readonly string[],
    limit: number,
    globalLimit: number,
    duration: number,
  ): Promise<boolean> {
    const script = `
      local global_key = KEYS[#KEYS]
      local global_count = redis.call('INCR', global_key)
      if global_count == 1 then redis.call('PEXPIRE', global_key, ARGV[2]) end
      if global_count > tonumber(ARGV[3]) then return 1 end
      local exceeded = 0
      for index = 1, #KEYS - 1 do
        local key = KEYS[index]
        local count = redis.call('INCR', key)
        if count == 1 then redis.call('PEXPIRE', key, ARGV[2]) end
        if count > tonumber(ARGV[1]) then exceeded = 1 end
      end
      return exceeded
    `;
    try {
      const result = await this.withDeadline(
        this.client!.eval(script, {
          keys: keys.map((key) => `${this.namespace}:rate:${key}`),
          arguments: [String(limit), String(duration), String(globalLimit)],
        }),
      );
      return Number(result) === 1;
    } catch {
      throw new HttpException(
        {
          code: 'AUTH_ADMISSION_UNAVAILABLE',
          message: 'Authentication is temporarily unavailable',
        },
        503,
      );
    }
  }

  /** Ограничивает время ожидания Redis и не допускает зависшего auth admission. */
  private async withDeadline<T>(operation: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('AUTH_RATE_REDIS_TIMEOUT')),
            this.commandTimeoutMs,
          );
          timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private checkMemory(
    keys: readonly string[],
    limit: number,
    globalLimit: number,
    duration: number,
    now: number,
  ): boolean {
    for (const [key, value] of this.windows)
      if (now - value.startedAt >= duration) this.windows.delete(key);
    const maximum = Number(this.config.get('AUTH_RATE_MAX_BUCKETS', '10000'));
    if (this.windows.size + keys.length > maximum) return true;
    let exceeded = false;
    for (const [index, key] of keys.entries()) {
      const previous = this.windows.get(key);
      const window =
        !previous || now - previous.startedAt >= duration ? { startedAt: now, count: 0 } : previous;
      window.count += 1;
      this.windows.set(key, window);
      exceeded ||= window.count > (index === keys.length - 1 ? globalLimit : limit);
    }
    return exceeded;
  }
}
