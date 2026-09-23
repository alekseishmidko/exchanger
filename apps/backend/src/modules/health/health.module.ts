import { Module } from '@nestjs/common';
import { HealthService } from './application/health.service';
import { HealthController } from './controllers/health.controller';
import { HEALTH_DEPENDENCIES } from './ports/health.tokens';
import { ConfigService } from '@nestjs/config';
import type { Pool } from 'pg';
import { POSTGRES_POOL } from '../../infrastructure/postgres';
import { SEQUENCER_STORE_PORT, SequencerModule, SequencerStorePort } from '../trading/sequencer';
import {
  ADMISSION_CONTROL_PORT,
  AdmissionControlModule,
  AdmissionControlPort,
} from '../admin/admission-control';
import {
  DURABLE_WORKER_MANAGER,
  DurableWorkerManager,
  TradingWorkersModule,
} from '../trading/workers';
import { IdentityModule, SESSION_STORE, SessionStore } from '../identity';

/** Собирает health endpoints, проверки зависимостей и HTTP-наблюдаемость. */
@Module({
  imports: [SequencerModule, AdmissionControlModule, TradingWorkersModule, IdentityModule],
  controllers: [HealthController],
  providers: [
    HealthService,
    {
      provide: HEALTH_DEPENDENCIES,
      inject: [
        ConfigService,
        POSTGRES_POOL,
        SEQUENCER_STORE_PORT,
        ADMISSION_CONTROL_PORT,
        DURABLE_WORKER_MANAGER,
        SESSION_STORE,
      ],
      useFactory: (
        config: ConfigService,
        pool: Pool,
        sequencer: SequencerStorePort,
        admission: AdmissionControlPort,
        workers: DurableWorkerManager,
        sessions: SessionStore,
      ) => {
        if (config.getOrThrow('RUNTIME_PROFILE') === 'component') return [];
        return [
          {
            name: 'postgresql',
            critical: true,
            check: async (): Promise<void> => {
              await pool.query('SELECT 1');
            },
          },
          {
            name: 'event-log',
            critical: true,
            check: async (): Promise<void> => {
              await pool.query('SELECT 1 FROM outbox_events LIMIT 1');
            },
          },
          { name: 'partition-lease', critical: true, check: () => sequencer.checkReady() },
          { name: 'admission-control', critical: true, check: () => admission.checkReady() },
          { name: 'durable-workers', critical: true, check: () => workers.checkReady() },
          { name: 'redis-sessions', critical: true, check: () => sessions.check() },
        ];
      },
    },
  ],
})
export class HealthModule {}
