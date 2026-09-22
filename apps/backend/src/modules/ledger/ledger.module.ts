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

/** Composition root ledger application boundary и его REST adapter. */
@Module({
  imports: [AuditModule, GatewayCommonModule],
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
