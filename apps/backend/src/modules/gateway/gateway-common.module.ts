/** Shared idempotency/rate-limit infrastructure used by HTTP boundaries. */
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { POSTGRES_TRANSACTION, PostgresTransactionManager } from '../../infrastructure/postgres';
import { IdempotencyStore } from './application/gateway.idempotency';
import { RateLimitService } from './application/gateway.rate-limit';
import { PostgresIdempotencyStore } from './infrastructure/postgres-idempotency.store';
import { IDEMPOTENCY_STORE_PORT, IdempotencyStorePort } from './ports/gateway.idempotency.port';

@Module({
  providers: [
    IdempotencyStore,
    {
      provide: IDEMPOTENCY_STORE_PORT,
      inject: [ConfigService, POSTGRES_TRANSACTION],
      useFactory: (
        config: ConfigService,
        transactions: PostgresTransactionManager,
      ): IdempotencyStorePort =>
        config.getOrThrow('IDEMPOTENCY_STORE_ADAPTER') === 'postgres'
          ? new PostgresIdempotencyStore(transactions)
          : new IdempotencyStore(),
    },
    RateLimitService,
  ],
  exports: [IdempotencyStore, IDEMPOTENCY_STORE_PORT, RateLimitService],
})
export class GatewayCommonModule {}
