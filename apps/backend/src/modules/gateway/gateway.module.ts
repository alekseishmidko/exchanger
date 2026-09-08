import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiKeyGuard, ApiKeyRegistry, ApiKeyRole } from './gateway.auth';
import { GatewayController } from './gateway.controller';
import { IdempotencyStore } from './gateway.idempotency';
import { RateLimitService } from './gateway.rate-limit';
import { InMemoryTradingCommandPort } from './gateway.types';

/**
 * Composition root Gateway-модуля.
 *
 * Здесь связываются security/application adapters: ConfigService создаёт registry,
 * guard выполняет authentication, а token `TRADING_COMMAND_PORT` позволяет
 * заменить in-memory core на sequencer без изменения controller. Значение
 * `GATEWAY_API_KEYS` имеет формат `key:role:userId,key2:admin:operator`.
 */
@Module({
  controllers: [GatewayController],
  providers: [
    {
      provide: ApiKeyRegistry,
      inject: [ConfigService],
      useFactory: (config: ConfigService): ApiKeyRegistry => {
        const raw = config.get<string>('GATEWAY_API_KEYS', 'dev-key:trader:dev-user');
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
    RateLimitService,
    { provide: 'TRADING_COMMAND_PORT', useClass: InMemoryTradingCommandPort },
  ],
  exports: [ApiKeyGuard, ApiKeyRegistry, IdempotencyStore, RateLimitService],
})
export class GatewayModule {}
