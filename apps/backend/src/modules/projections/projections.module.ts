import { Module } from '@nestjs/common';
import { GatewayCommonModule } from '../gateway/gateway-common.module';
import { ConfigService } from '@nestjs/config';
import { POSTGRES_TRANSACTION, PostgresTransactionManager } from '../../infrastructure/postgres';
import { ProjectionStore } from './application/projection.store';
import { ProjectionsController } from './controllers/projections.controller';
import { PostgresProjectionStore } from './infrastructure/postgres-projection.store';
import { PROJECTION_STORE_PORT } from './ports/projection.port';
import type { ProjectionStorePort } from './ports/projection.port';

/** Собирает read-model store и query API, используя только gateway auth boundary. */
@Module({
  imports: [GatewayCommonModule],
  controllers: [ProjectionsController],
  providers: [
    ProjectionStore,
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
  exports: [PROJECTION_STORE_PORT],
})
export class ProjectionsModule {}
