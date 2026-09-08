import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { resolve } from 'node:path';
import { validateEnvironment } from './config/environment';
import { HealthModule } from './modules/health/health.module';
import { GatewayModule } from './modules/gateway/gateway.module';
import { ProjectionsModule } from './modules/projections/projections.module';
import { MarketDataModule } from './modules/market-data/market-data.module';
import { AdminModule } from './modules/admin';
import { InstrumentsModule } from './modules/trading/instruments';
import { LedgerModule } from './modules/ledger';

/** Корневой composition root приложения и глобальной конфигурации. */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [
        resolve(__dirname, `../../../.env.${process.env['NODE_ENV'] ?? 'development'}`),
        resolve(__dirname, '../../../.env.development'),
        resolve(__dirname, '../../../.env'),
      ],
      validate: validateEnvironment,
    }),
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
