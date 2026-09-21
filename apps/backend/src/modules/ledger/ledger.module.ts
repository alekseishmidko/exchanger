import { Module } from '@nestjs/common';
import { AuditModule } from '../audit';
import { GatewayModule } from '../gateway';
import { LedgerApplicationService } from './ledger-application.service';
import { LedgerController } from './ledger.controller';
import { Ledger } from './ledger';
import { LEDGER_PORT } from './ledger.port';
import { ConfigService } from '@nestjs/config';
import { POSTGRES_TRANSACTION, PostgresTransactionManager } from '../../infrastructure/postgres';
import { PostgresLedgerAdapter } from './postgres-ledger.adapter';
import type { LedgerPort } from './ledger.port';

/** Composition root ledger application boundary и его REST adapter. */
@Module({
  imports: [AuditModule, GatewayModule],
  controllers: [LedgerController],
  providers: [
    {
      provide: LEDGER_PORT,
      inject: [ConfigService, POSTGRES_TRANSACTION],
      useFactory: (config: ConfigService, transactions: PostgresTransactionManager): LedgerPort =>
        config.getOrThrow('LEDGER_STORE_ADAPTER') === 'postgres'
          ? new PostgresLedgerAdapter(transactions)
          : new Ledger(),
    },
    LedgerApplicationService,
  ],
  exports: [LEDGER_PORT, LedgerApplicationService],
})
export class LedgerModule {}
