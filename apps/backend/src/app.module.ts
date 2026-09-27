import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { resolve } from 'node:path';
import { environmentFilePaths, validateEnvironment } from './config/environment';
import { HealthModule } from './modules/health';
import { GatewayModule } from './modules/gateway';
import { ProjectionsModule } from './modules/projections';
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
import { AdmissionControlModule } from './modules/admin/admission-control';
import { TradingWorkersModule } from './modules/trading/workers';
import { AuthModule } from './modules/auth';

/** Корневой composition root приложения и глобальной конфигурации. */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [...environmentFilePaths(resolve(__dirname, '..'))],
      validate: validateEnvironment,
    }),
    PostgresModule,
    EventLogModule,
    AuditModule,
    AuthModule,
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
    TradingWorkersModule,
    AdminModule,
  ],
  providers: [RuntimeSafetyService],
})
export class AppModule {}
