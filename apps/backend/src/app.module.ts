import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { environmentFilePaths, validateEnvironment } from './config/environment';
import { HealthModule } from './modules/health/health.module';
import { GatewayModule } from './modules/gateway/gateway.module';
import { ProjectionsModule } from './modules/projections/projections.module';
import { MarketDataModule } from './modules/market-data/market-data.module';
import { AdminModule } from './modules/admin';
import { InstrumentsModule } from './modules/trading/instruments';
import { LedgerModule } from './modules/ledger';
import { ObservabilityModule } from './modules/observability';
import { RuntimeSafetyService } from './config/runtime-safety.service';
import { PostgresModule } from './infrastructure/postgres';
import { EventLogModule } from './modules/trading/event-log';
import { AuditModule } from './modules/audit';
import { SettlementModule } from './modules/trading/settlement';
import { SequencerModule } from './modules/trading/sequencer';
import { AdmissionControlModule } from './modules/admin/admission-control.module';

/** Корневой composition root приложения и глобальной конфигурации. */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [...environmentFilePaths(__dirname)],
      validate: validateEnvironment,
    }),
    PostgresModule,
    EventLogModule,
    AuditModule,
    SequencerModule,
    AdmissionControlModule,
    ObservabilityModule,
    HealthModule,
    GatewayModule,
    ProjectionsModule,
    MarketDataModule,
    InstrumentsModule,
    LedgerModule,
    SettlementModule,
    AdminModule,
  ],
  providers: [RuntimeSafetyService],
})
export class AppModule {}
