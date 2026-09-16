import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { POSTGRES_TRANSACTION, PostgresTransactionManager } from '../../infrastructure/postgres';
import { ADMISSION_CONTROL_PORT, AdmissionControlPort } from './admission-control.port';
import { MemoryAdmissionControl } from './memory-admission-control';
import { PostgresAdmissionControl } from './postgres-admission-control';

/** Shared composition root operational controls без зависимости от transport modules. */
@Module({
  providers: [
    {
      provide: ADMISSION_CONTROL_PORT,
      inject: [ConfigService, POSTGRES_TRANSACTION],
      useFactory: (
        config: ConfigService,
        transactions: PostgresTransactionManager,
      ): AdmissionControlPort =>
        config.getOrThrow('ADMISSION_CONTROL_ADAPTER') === 'postgres'
          ? new PostgresAdmissionControl(transactions)
          : new MemoryAdmissionControl(),
    },
  ],
  exports: [ADMISSION_CONTROL_PORT],
})
export class AdmissionControlModule {}
