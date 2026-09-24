import { Inject, Injectable, OnApplicationShutdown, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LOG_EVENTS, StructuredLogger } from '../../observability';
import { USER_STORE, UserStore } from '../ports/identity.ports';

/**
 * Bounded retention worker для consumed/expired recovery metadata.
 * Human sessions удаляются Redis TTL, а PostgreSQL challenges очищаются малыми
 * batches, чтобы maintenance не создавал долгих locks или unbounded transaction.
 */
@Injectable()
export class IdentityRetentionService implements OnModuleInit, OnApplicationShutdown {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    @Inject(USER_STORE) private readonly users: UserStore,
    private readonly config: ConfigService,
    @Optional() private readonly logger?: StructuredLogger,
  ) {}

  /** Запускает unref timer; первый cleanup происходит без задержки startup. */
  onModuleInit(): void {
    const interval = Number(this.config.get('AUTH_RETENTION_INTERVAL_MS', '3600000'));
    this.timer = setInterval(() => void this.cleanup(), interval);
    this.timer.unref();
    void this.cleanup().catch(() => undefined);
  }

  /** Останавливает maintenance при graceful shutdown. */
  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async cleanup(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const removed = await this.users.cleanupExpiredChallenges(
        Number(this.config.get('AUTH_RETENTION_BATCH_SIZE', '500')),
      );
      this.logger?.info('identity', LOG_EVENTS.AUTH_RETENTION_CLEANUP, {
        metadata: { removed },
      });
    } finally {
      this.running = false;
    }
  }
}
