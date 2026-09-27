import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Pool } from 'pg';
import {
  POSTGRES_POOL,
  POSTGRES_TRANSACTION,
  type PostgresTransactionManager,
} from '../../infrastructure/postgres';
import { AuthModule } from '../auth';
import { AuditModule } from '../audit';
import { GatewayCommonModule } from '../gateway/gateway-common.module';
import { LedgerModule } from '../ledger';
import { MarketDataModule } from '../market-data/market-data.module';
import { RealtimeExecutionService } from './application/realtime-execution.service';
import { RealtimeMarketHub } from './application/realtime-market-hub';
import { ReferenceDataSyncService } from './application/reference-data-sync.service';
import { PriceStreamSupervisor } from './application/price-stream-supervisor';
import { RealtimeMarketStatusService } from './application/realtime-market-status.service';
import { RealtimeMarketController } from './controllers/realtime-market.controller';
import { RealtimeMarketAdminController } from './controllers/realtime-market-admin.controller';
import { RealtimeExecutionController } from './controllers/realtime-execution.controller';
import { RealtimeMarketGateway } from './gateways/realtime-market.gateway';
import { MemoryRealtimeExecutionRepository } from './infrastructure/memory-realtime-execution.repository';
import { PostgresRealtimeExecutionRepository } from './infrastructure/postgres-realtime-execution.repository';
import { MemoryRealtimeCatalog } from './infrastructure/memory-realtime-catalog';
import { MemoryQuoteStore } from './infrastructure/memory-quote.store';
import { PostgresRealtimeCatalog } from './infrastructure/postgres-realtime-catalog';
import { RedisQuoteStore } from './infrastructure/redis-quote.store';
import { TwelveDataRestClient } from './infrastructure/twelve-data-rest.client';
import { QUOTE_STORE_PORT, type QuoteStorePort } from './ports/quote-store.port';
import { REALTIME_CATALOG_PORT, type RealtimeCatalogPort } from './ports/realtime-catalog.port';
import {
  REFERENCE_DATA_PROVIDER,
  type ReferenceDataProviderPort,
} from './ports/reference-data-provider.port';
import {
  REALTIME_EXECUTION_REPOSITORY,
  type RealtimeExecutionRepositoryPort,
} from './ports/realtime-execution.port';

@Module({
  imports: [AuthModule, AuditModule, GatewayCommonModule, LedgerModule, MarketDataModule],
  controllers: [
    RealtimeMarketController,
    RealtimeMarketAdminController,
    RealtimeExecutionController,
  ],
  providers: [
    RealtimeMarketStatusService,
    RealtimeMarketHub,
    RealtimeMarketGateway,
    {
      provide: REALTIME_CATALOG_PORT,
      inject: [ConfigService, POSTGRES_POOL, POSTGRES_TRANSACTION],
      useFactory: (
        config: ConfigService,
        pool: Pool,
        transactions: PostgresTransactionManager,
      ): RealtimeCatalogPort =>
        config.getOrThrow('RUNTIME_PROFILE') === 'component'
          ? new MemoryRealtimeCatalog()
          : new PostgresRealtimeCatalog(pool, transactions),
    },
    {
      provide: REFERENCE_DATA_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService): ReferenceDataProviderPort =>
        new TwelveDataRestClient(
          config.get('TWELVE_DATA_REST_URL', 'https://api.twelvedata.com'),
          config.get('TWELVE_DATA_API_KEY', ''),
          Number(config.get('TWELVE_DATA_REQUEST_TIMEOUT_MS', '5000')),
        ),
    },
    {
      provide: QUOTE_STORE_PORT,
      inject: [ConfigService],
      useFactory: (config: ConfigService): QuoteStorePort =>
        ['true', '1'].includes(config.get('TWELVE_DATA_ENABLED', 'false'))
          ? new RedisQuoteStore(
              config.getOrThrow('TWELVE_DATA_REDIS_URL'),
              Number(config.get('TWELVE_DATA_QUOTE_TTL_MS', '15000')),
            )
          : new MemoryQuoteStore(),
    },
    {
      provide: REALTIME_EXECUTION_REPOSITORY,
      inject: [ConfigService, POSTGRES_POOL, POSTGRES_TRANSACTION],
      useFactory: (
        config: ConfigService,
        pool: Pool,
        transactions: PostgresTransactionManager,
      ): RealtimeExecutionRepositoryPort =>
        config.getOrThrow('RUNTIME_PROFILE') === 'component'
          ? new MemoryRealtimeExecutionRepository()
          : new PostgresRealtimeExecutionRepository(pool, transactions),
    },
    ReferenceDataSyncService,
    PriceStreamSupervisor,
    RealtimeExecutionService,
  ],
  exports: [
    REALTIME_CATALOG_PORT,
    QUOTE_STORE_PORT,
    REALTIME_EXECUTION_REPOSITORY,
    RealtimeMarketStatusService,
  ],
})
export class RealtimeMarketModule {}
