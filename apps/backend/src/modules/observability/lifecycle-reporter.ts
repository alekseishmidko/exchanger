import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { LOG_EVENTS } from './log-events';
import { StructuredLogger } from './structured-logger';

/** Пишет terminal shutdown event через тот же structured logger. */
@Injectable()
export class LifecycleReporter implements OnApplicationShutdown {
  constructor(private readonly logger: StructuredLogger) {}

  /** Фиксирует signal без stack/payload перед завершением Nest lifecycle. */
  onApplicationShutdown(signal?: string): void {
    this.logger.info('bootstrap', LOG_EVENTS.SYSTEM_SHUTDOWN, {
      metadata: { signal: signal ?? 'application-close' },
    });
  }
}
