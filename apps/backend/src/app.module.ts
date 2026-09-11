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

/** Корневой composition root приложения и глобальной конфигурации. */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [...environmentFilePaths(__dirname)],
      validate: validateEnvironment,
    }),
    ObservabilityModule,
    HealthModule,
    GatewayModule,
    ProjectionsModule,
    MarketDataModule,
    InstrumentsModule,
    LedgerModule,
    AdminModule,
  ],
})
export class AppModule {}
