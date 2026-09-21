import { Module } from '@nestjs/common';
import { GatewayModule } from '../gateway';
import { ProjectionsController } from './projections.controller';
import { ProjectionStore } from './projection';
import { PROJECTION_STORE_PORT } from './projection.port';
import { ConfigService } from '@nestjs/config';
import { POSTGRES_TRANSACTION, PostgresTransactionManager } from '../../infrastructure/postgres';
import { PostgresProjectionStore } from './postgres-projection.store';
import type { ProjectionStorePort } from './projection.port';

/** Собирает read-model store и query API, используя только gateway auth boundary. */
@Module({
  imports: [GatewayModule],
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
