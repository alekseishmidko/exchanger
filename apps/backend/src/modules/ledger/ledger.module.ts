import { Module } from '@nestjs/common';
import { AuditModule } from '../audit';
import { GatewayModule } from '../gateway/gateway.module';
import { LedgerApplicationService } from './ledger-application.service';
import { LedgerController } from './ledger.controller';

/** Composition root ledger application boundary и его REST adapter. */
@Module({
  imports: [AuditModule, GatewayModule],
  controllers: [LedgerController],
  providers: [LedgerApplicationService],
  exports: [LedgerApplicationService],
})
export class LedgerModule {}
