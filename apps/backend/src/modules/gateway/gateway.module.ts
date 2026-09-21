/**
 * Файл связывает Gateway как Nest composition root.
 *
 * Здесь выбираются concrete adapters для API-key registry, idempotency store и
 * trading command port. Контроллеры зависят только от DI tokens, поэтому
 * переключение между memory и PostgreSQL runtime не меняет HTTP handlers.
 */
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditModule } from '../audit';
import { ApiKeyGuard, ApiKeyRegistry, ApiKeyRole } from './auth/gateway.auth';
import { IdempotencyStore } from './application/gateway.idempotency';
import { RateLimitService } from './application/gateway.rate-limit';
import { AuthenticationController } from './controllers/auth.controller';
import { GatewayController } from './controllers/gateway.controller';
import { POSTGRES_TRANSACTION, PostgresTransactionManager } from '../../infrastructure/postgres';
import { PostgresIdempotencyStore } from './infrastructure/postgres-idempotency.store';
import { PostgresTradingCommandAdapter } from './infrastructure/postgres-trading-command.adapter';
import { IDEMPOTENCY_STORE_PORT } from './ports/gateway.idempotency.port';
import type { IdempotencyStorePort } from './ports/gateway.idempotency.port';
import { InMemoryTradingCommandPort, TRADING_COMMAND_PORT } from './types/gateway.types';
import type { TradingCommandPort } from './types/gateway.types';
import { AdmissionControlModule } from '../admin/admission-control';
import { SEQUENCER_STORE_PORT, SequencerModule, SequencerStorePort } from '../trading/sequencer';

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
  imports: [AuditModule, SequencerModule, AdmissionControlModule],
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
      inject: [ConfigService, POSTGRES_TRANSACTION, SEQUENCER_STORE_PORT],
      useFactory: (
        config: ConfigService,
        transactions: PostgresTransactionManager,
        sequencer: SequencerStorePort,
      ): TradingCommandPort =>
        config.getOrThrow('COMMAND_STORE_ADAPTER') === 'postgres'
          ? new PostgresTradingCommandAdapter(
              transactions,
              sequencer,
              config.getOrThrow('INSTANCE_ID'),
              Number(config.get('PARTITION_LEASE_TTL_MS', '15000')),
            )
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
