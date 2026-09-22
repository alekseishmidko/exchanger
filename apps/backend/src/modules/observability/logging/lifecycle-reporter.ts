import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { LOG_EVENTS } from './log-events';
import { StructuredLogger } from './structured-logger';

/** Пишет terminal shutdown event через тот же structured logger. */
@Injectable()
export class LifecycleReporter implements OnApplicationShutdown {
  /**
   * Подключает lifecycle hook к единому logger вместо прямого console output.
   *
   * @param logger Adapter production JSON logging с redaction и event allow-list.
   */
  constructor(private readonly logger: StructuredLogger) {}

  /**
   * Фиксирует signal без stack/payload перед завершением Nest lifecycle.
   * Например, SIGTERM от оркестратора становится безопасной metadata, после чего
   * остальные providers могут завершить bounded telemetry queues.
   *
   * @param signal Системный сигнал или undefined при программном `app.close()`.
   */
  onApplicationShutdown(signal?: string): void {
    this.logger.info('bootstrap', LOG_EVENTS.SYSTEM_SHUTDOWN, {
      metadata: { signal: signal ?? 'application-close' },
    });
  }
}
