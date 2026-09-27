import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { POSTGRES_TRANSACTION, PostgresTransactionManager } from '../../../infrastructure/postgres';
import { ADMISSION_CONTROL_PORT, AdmissionControlPort } from '../ports/admission-control.port';
import { MemoryAdmissionControl } from './memory-admission-control';
import { PostgresAdmissionControl } from './postgres-admission-control';

/** Shared composition root operational controls без зависимости от transport modules. */
@Module({
  providers: [
    /** Связывает стабильный port с memory или PostgreSQL adapter согласно runtime profile. */
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
  /** Соседние модули получают только port и не знают о выбранном storage adapter. */
  exports: [ADMISSION_CONTROL_PORT],
})
export class AdmissionControlModule {}
