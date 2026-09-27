import { Module } from '@nestjs/common';
import { AuditModule } from '../audit';
import { GatewayCommonModule } from '../gateway/gateway-common.module';
import { ConfigService } from '@nestjs/config';
import { POSTGRES_TRANSACTION, PostgresTransactionManager } from '../../infrastructure/postgres';
import { LedgerApplicationService } from './application/ledger-application.service';
import { LedgerController } from './controllers/ledger.controller';
import { Ledger } from './domain/ledger';
import { PostgresLedgerAdapter } from './infrastructure/postgres-ledger.adapter';
import { LEDGER_PORT } from './ports/ledger.port';
import type { LedgerPort } from './ports/ledger.port';
import { AuthModule } from '../auth';

/** Composition root ledger application boundary и его REST adapter. */
@Module({
  imports: [
    /** Аудирует административные изменения счетов и балансов. */
    AuditModule,
    /** Защищает account endpoints machine/human principals и role checks. */
    AuthModule,
    /** Добавляет idempotency и bounded rate limiting для balance commands. */
    GatewayCommonModule,
  ],
  /** Публикует account/balance query и административные balance commands. */
  controllers: [LedgerController],
  providers: [
    /** Выбирает in-memory ledger либо transactional PostgreSQL adapter. */
    {
      provide: LEDGER_PORT,
      inject: [ConfigService, POSTGRES_TRANSACTION],
      useFactory: (config: ConfigService, transactions: PostgresTransactionManager): LedgerPort =>
        config.getOrThrow('LEDGER_STORE_ADAPTER') === 'postgres'
          ? new PostgresLedgerAdapter(transactions)
          : new Ledger(),
    },
    /** Оркестрирует account и balance use cases поверх ledger port. */
    LedgerApplicationService,
  ],
  /** Settlement/runtime используют port, а transport переиспользует application service. */
  exports: [LEDGER_PORT, LedgerApplicationService],
})
export class LedgerModule {}
