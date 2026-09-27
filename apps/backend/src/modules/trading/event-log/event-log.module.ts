import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { POSTGRES_TRANSACTION, PostgresTransactionManager } from '../../../infrastructure/postgres';
import { EventLog } from './event-log';
import { EVENT_LOG_PORT, EventLogPort } from './event-log.port';
import { PostgresEventLogAdapter } from './postgres-event-log.adapter';

/**
 * Composition root append-only event log.
 *
 * Component profile получает детерминированный in-memory log. Production-like
 * profile создаёт PostgreSQL outbox adapter; неизвестное значение уже отклонено
 * общей env validation до выполнения factory.
 */
@Module({
  providers: [
    /** Связывает event-log port с in-memory log или transactional outbox adapter. */
    {
      provide: EVENT_LOG_PORT,
      inject: [ConfigService, POSTGRES_TRANSACTION],
      useFactory: (
        config: ConfigService,
        transactions: PostgresTransactionManager,
      ): EventLogPort =>
        config.getOrThrow('EVENT_LOG_ADAPTER') === 'postgres-outbox'
          ? new PostgresEventLogAdapter(transactions)
          : new EventLog(),
    },
  ],
  /** Producers/consumers используют append/read contract без знания storage implementation. */
  exports: [EVENT_LOG_PORT],
})
export class EventLogModule {}
