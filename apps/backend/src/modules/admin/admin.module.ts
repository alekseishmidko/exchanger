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
  imports: [
    /** Фиксирует каждую административную мутацию в tamper-evident журнале. */
    AuditModule,
    /** Даёт reconciliation доступ к command boundary и общей idempotency infrastructure. */
    GatewayModule,
    /** Применяет одобренные изменения к каталогу и lifecycle инструментов. */
    InstrumentsModule,
    /** Выполняет freeze, pause и circuit-breaker через единый operational-control port. */
    AdmissionControlModule,
  ],
  /** Публикует защищённый HTTP boundary административных операций. */
  controllers: [AdminController],
  providers: [
    /** Хранит и проверяет допустимые risk/fee/admin policies. */
    AdminPolicyRegistry,
    /** Требует независимые approvals перед выполнением чувствительных команд. */
    AdminDualControlService,
    /** Сверяет commands, outbox, projections, balances и audit chain. */
    AdminReconciliationService,
    /** Оркестрирует административные use cases поверх перечисленных policies. */
    AdminService,
  ],
  /** Позволяет внутренним модулям вызывать admin use cases без зависимости от HTTP. */
  exports: [AdminService],
})
export class AdminModule {}
