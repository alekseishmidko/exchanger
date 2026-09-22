import { Module } from '@nestjs/common';
import { AuditModule } from '../audit';
import { AdminService } from './admin.service';
import { AdminPolicyRegistry } from './policies/admin-policy-registry.service';
import { AdminDualControlService } from './services/admin-dual-control.service';
import { AdminReconciliationService } from './services/admin-reconciliation.service';
import { GatewayModule } from '../gateway';
import { InstrumentsModule } from '../trading/instruments';
import { AdminController } from './controllers/admin.controller';
import { AdmissionControlModule } from './infrastructure/admission-control.module';

/** Composition root административного сервиса и tamper-evident audit dependency. */
@Module({
  imports: [AuditModule, GatewayModule, InstrumentsModule, AdmissionControlModule],
  controllers: [AdminController],
  providers: [
    AdminPolicyRegistry,
    AdminDualControlService,
    AdminReconciliationService,
    AdminService,
  ],
  exports: [AdminService],
})
export class AdminModule {}
