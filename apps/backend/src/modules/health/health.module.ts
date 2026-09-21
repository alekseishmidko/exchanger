import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { HEALTH_DEPENDENCIES } from './health.tokens';
import { ConfigService } from '@nestjs/config';
import type { Pool } from 'pg';
import { POSTGRES_POOL } from '../../infrastructure/postgres';
import { SEQUENCER_STORE_PORT, SequencerModule, SequencerStorePort } from '../trading/sequencer';
import {
  ADMISSION_CONTROL_PORT,
  AdmissionControlModule,
  AdmissionControlPort,
} from '../admin/admission-control';

/** Собирает health endpoints, проверки зависимостей и HTTP-наблюдаемость. */
@Module({
  imports: [SequencerModule, AdmissionControlModule],
  controllers: [HealthController],
  providers: [
    HealthService,
    {
      provide: HEALTH_DEPENDENCIES,
      inject: [ConfigService, POSTGRES_POOL, SEQUENCER_STORE_PORT, ADMISSION_CONTROL_PORT],
      useFactory: (
        config: ConfigService,
        pool: Pool,
        sequencer: SequencerStorePort,
        admission: AdmissionControlPort,
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
        ];
      },
    },
  ],
})
export class HealthModule {}
