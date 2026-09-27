import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { POSTGRES_TRANSACTION, PostgresTransactionManager } from '../../../infrastructure/postgres';
import { MemorySequencerStore } from './memory-sequencer.store';
import { PostgresSequencerStore } from './postgres-sequencer.store';
import { SEQUENCER_STORE_PORT, SequencerStorePort } from './sequencer.port';

/** Composition root durable partition ownership и recovery store. */
@Module({
  providers: [
    /** Выбирает локальный sequencer либо PostgreSQL lease/recovery implementation. */
    {
      provide: SEQUENCER_STORE_PORT,
      inject: [ConfigService, POSTGRES_TRANSACTION],
      useFactory: (
        config: ConfigService,
        transactions: PostgresTransactionManager,
      ): SequencerStorePort =>
        config.getOrThrow('SEQUENCER_STORE_ADAPTER') === 'postgres'
          ? new PostgresSequencerStore(transactions)
          : new MemorySequencerStore(),
    },
  ],
  /** Command admission и health checks используют единый sequencer port. */
  exports: [SEQUENCER_STORE_PORT],
})
export class SequencerModule {}
