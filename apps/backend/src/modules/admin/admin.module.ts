import { Module } from '@nestjs/common';
import { AuditModule } from '../audit';
import { AdminService } from './admin.service';
import { GatewayModule } from '../gateway/gateway.module';
import { InstrumentsModule } from '../trading/instruments';
import { AdminController } from './admin.controller';
import { AdmissionControlModule } from './admission-control.module';

/** Composition root административного сервиса и tamper-evident audit dependency. */
@Module({
  imports: [AuditModule, GatewayModule, InstrumentsModule, AdmissionControlModule],
  controllers: [AdminController],
  providers: [AdminService],
  exports: [AdminService],
})
export class AdminModule {}
