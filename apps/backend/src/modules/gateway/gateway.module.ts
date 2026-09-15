import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditModule } from '../audit';
import { ApiKeyGuard, ApiKeyRegistry, ApiKeyRole } from './gateway.auth';
import { GatewayController } from './gateway.controller';
import { IdempotencyStore } from './gateway.idempotency';
import { IDEMPOTENCY_STORE_PORT } from './gateway.idempotency.port';
import { RateLimitService } from './gateway.rate-limit';
import { InMemoryTradingCommandPort, TRADING_COMMAND_PORT } from './gateway.types';
import { AuthenticationController } from './auth.controller';
import { POSTGRES_TRANSACTION, PostgresTransactionManager } from '../../infrastructure/postgres';
import { PostgresIdempotencyStore } from './postgres-idempotency.store';
import { PostgresTradingCommandAdapter } from './postgres-trading-command.adapter';
import type { IdempotencyStorePort } from './gateway.idempotency.port';
import type { TradingCommandPort } from './gateway.types';

/**
 * Composition root Gateway-модуля.
 *
 * Здесь связываются security/application adapters: ConfigService создаёт registry,
 * guard выполняет authentication, а token `TRADING_COMMAND_PORT` позволяет
 * заменить in-memory core на sequencer без изменения controller. Значение
 * `GATEWAY_API_KEYS` имеет формат `key:role:userId,key2:admin:operator`.
 * Development fallback добавляет `dev-key` и `dev-admin-key`; production не
 * получает default credentials.
 */
@Module({
  imports: [AuditModule],
  controllers: [AuthenticationController, GatewayController],
  providers: [
    {
      provide: ApiKeyRegistry,
      inject: [ConfigService],
      useFactory: (config: ConfigService): ApiKeyRegistry => {
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
    {
      provide: TRADING_COMMAND_PORT,
      inject: [ConfigService, POSTGRES_TRANSACTION],
      useFactory: (
        config: ConfigService,
        transactions: PostgresTransactionManager,
      ): TradingCommandPort =>
        config.getOrThrow('COMMAND_STORE_ADAPTER') === 'postgres'
          ? new PostgresTradingCommandAdapter(transactions)
          : new InMemoryTradingCommandPort(),
    },
  ],
  exports: [
    ApiKeyGuard,
    ApiKeyRegistry,
    IdempotencyStore,
    IDEMPOTENCY_STORE_PORT,
    TRADING_COMMAND_PORT,
    RateLimitService,
  ],
})
export class GatewayModule {}
