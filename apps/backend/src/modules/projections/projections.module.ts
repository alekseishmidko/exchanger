import { Module } from '@nestjs/common';
import { GatewayCommonModule } from '../gateway/gateway-common.module';
import { ConfigService } from '@nestjs/config';
import { POSTGRES_TRANSACTION, PostgresTransactionManager } from '../../infrastructure/postgres';
import { ProjectionStore } from './application/projection.store';
import { ProjectionsController } from './controllers/projections.controller';
import { PostgresProjectionStore } from './infrastructure/postgres-projection.store';
import { PROJECTION_STORE_PORT } from './ports/projection.port';
import type { ProjectionStorePort } from './ports/projection.port';
import { AuthModule } from '../auth';

/** Собирает read-model store и query API, используя публичный auth boundary. */
@Module({
  imports: [
    /** Проверяет principal перед чтением пользовательских projection данных. */
    AuthModule,
    /** Применяет общие query limits и rate limiting к read API. */
    GatewayCommonModule,
  ],
  /** Публикует bounded queries для orders, trades, balances и projection metrics. */
  controllers: [ProjectionsController],
  providers: [
    /** In-memory read-model store для component runtime и unit tests. */
    ProjectionStore,
    /** Выбирает memory либо versioned PostgreSQL projection store. */
    {
      provide: PROJECTION_STORE_PORT,
      inject: [ConfigService, POSTGRES_TRANSACTION, ProjectionStore],
      useFactory: (
        config: ConfigService,
        transactions: PostgresTransactionManager,
        memory: ProjectionStore,
      ): ProjectionStorePort =>
        config.getOrThrow('PROJECTION_STORE_ADAPTER') === 'postgres'
          ? new PostgresProjectionStore(transactions)
          : memory,
    },
  ],
  /** Writers и query boundary зависят от port, а не от concrete store. */
  exports: [PROJECTION_STORE_PORT],
})
export class ProjectionsModule {}
