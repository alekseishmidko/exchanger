/**
 * Общий security/application boundary Gateway без REST controllers.
 *
 * Модуль даёт соседним adapters единый `ApiKeyRegistry`, `ApiKeyGuard`,
 * idempotency store и rate limiter без импорта всего `GatewayModule`. Это
 * разрывает цикл между REST Gateway, WebSocket market-data и trading runtime:
 * transport boundary может пользоваться auth, но не подтягивает command API.
 *
 * @example `MarketDataModule` импортирует `GatewayCommonModule` и получает
 * `ApiKeyRegistry` для private subscriptions, не импортируя REST controllers.
 */
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  POSTGRES_POOL,
  POSTGRES_TRANSACTION,
  PostgresTransactionManager,
} from '../../infrastructure/postgres';
import type { Pool } from 'pg';
import { IdempotencyStore } from './application/gateway.idempotency';
import { RateLimitService } from './application/gateway.rate-limit';
import { ApiKeyGuard, ApiKeyRegistry, ApiKeyRole } from './auth/gateway.auth';
import { PostgresIdempotencyStore } from './infrastructure/postgres-idempotency.store';
import { IDEMPOTENCY_STORE_PORT } from './ports/gateway.idempotency.port';
import type { IdempotencyStorePort } from './ports/gateway.idempotency.port';
import { IdentityModule } from '../identity';
import { PostgresApiKeyRegistry } from './infrastructure/postgres-api-key.registry';

/** Shared providers Gateway security boundary. */
@Module({
  imports: [IdentityModule],
  providers: [
    {
      provide: ApiKeyRegistry,
      inject: [ConfigService, POSTGRES_POOL],
      useFactory: (config: ConfigService, pool: Pool): ApiKeyRegistry => {
        if (config.getOrThrow('AUTH_API_KEY_STORE_ADAPTER') === 'postgres') {
          return new PostgresApiKeyRegistry(pool);
        }
        const environment = config.getOrThrow<string>('NODE_ENV');
        const developmentKeys = 'dev-key:trader:dev-user,dev-admin-key:admin:dev-admin-user';
        const raw = config.get<string>(
          'GATEWAY_API_KEYS',
          environment === 'production' ? '' : developmentKeys,
        );
        const entries = raw
          .split(',')
          .filter(Boolean)
          .map((item) => {
            const [keyId, role = 'trader', userId = keyId] = item.split(':');
            const supportedRoles: readonly ApiKeyRole[] = [
              'trader',
              'admin',
              'risk_manager',
              'auditor',
              'support',
            ];
            return {
              keyId: keyId ?? '',
              role: supportedRoles.includes(role as ApiKeyRole) ? (role as ApiKeyRole) : 'trader',
              userId: userId ?? keyId ?? '',
            } as const;
          });
        return new ApiKeyRegistry(entries);
      },
    },
    ApiKeyGuard,
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
  exports: [
    IdentityModule,
    ApiKeyRegistry,
    ApiKeyGuard,
    IdempotencyStore,
    IDEMPOTENCY_STORE_PORT,
    RateLimitService,
  ],
})
export class GatewayCommonModule {}
