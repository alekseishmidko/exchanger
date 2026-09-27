/**
 * Nest composition root authentication capability.
 *
 * Dependency direction: HTTP controllers → auth application/security → identity
 * storage ports. Trading Gateway импортирует только exported guards/principals и
 * не создаёт credentials. Выбор memory/PostgreSQL registry выполняется здесь,
 * поэтому domain и controllers не читают environment напрямую.
 */
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Pool } from 'pg';
import {
  POSTGRES_POOL,
  POSTGRES_TRANSACTION,
  PostgresTransactionManager,
} from '../../infrastructure/postgres';
import { AuditModule } from '../audit';
import { GatewayCommonModule } from '../gateway/gateway-common.module';
import { IdentityModule } from '../identity';
import { HumanAuthService } from './application/human-auth.service';
import { AdminSessionsController } from './controllers/admin-sessions.controller';
import { MachineAuthenticationController } from './controllers/machine-authentication.controller';
import { UserAuthenticationController } from './controllers/user-authentication.controller';
import { UsersSelfServiceController } from './controllers/users.controller';
import { ApiKeyGuard, ApiKeyRegistry, ApiKeyRole } from './domain/authentication';
import { PostgresApiKeyRegistry } from './infrastructure/postgres-api-key.registry';
import { AuthRateLimit } from './security/auth-rate-limit';
import { CsrfGuard } from './security/csrf.guard';
import { HumanSessionGuard } from './security/human-session.guard';
import { PasswordHasher } from './security/password-hasher';
import { SessionCookieService } from './security/session-cookie.service';

/**
 * Связывает human и machine authentication в единую capability.
 *
 * Входящий human request проходит controller validation, rate limit, application
 * use case и cookie adapter. Protected request проходит HumanSessionGuard/CSRF.
 * Machine request проходит ApiKeyGuard и затем policy helpers. Экспортируются
 * только providers, необходимые соседним transport-модулям; DTO и persistence
 * adapters остаются внутренними деталями AuthModule.
 */
@Module({
  imports: [AuditModule, IdentityModule, GatewayCommonModule],
  controllers: [
    UserAuthenticationController,
    MachineAuthenticationController,
    UsersSelfServiceController,
    AdminSessionsController,
  ],
  providers: [
    HumanAuthService,
    PasswordHasher,
    AuthRateLimit,
    HumanSessionGuard,
    CsrfGuard,
    SessionCookieService,
    /** Выбирает durable registry для production-like profile или bounded in-memory registry. */
    {
      provide: ApiKeyRegistry,
      inject: [ConfigService, POSTGRES_POOL, POSTGRES_TRANSACTION],
      useFactory: (
        config: ConfigService,
        pool: Pool,
        transactions: PostgresTransactionManager,
      ): ApiKeyRegistry => {
        /** PostgreSQL registry проверяет live revoke/expiry на каждой replica. */
        if (config.getOrThrow('AUTH_API_KEY_STORE_ADAPTER') === 'postgres') {
          return new PostgresApiKeyRegistry(pool, transactions);
        }
        const supportedRoles: readonly ApiKeyRole[] = [
          'trader',
          'admin',
          'risk_manager',
          'auditor',
          'support',
        ];
        /** Configured keys предназначены только для явно выбранного memory adapter. */
        const entries = config
          .get<string>('GATEWAY_API_KEYS', '')
          .split(',')
          .filter(Boolean)
          .map((item) => {
            const [keyId, role = 'trader', userId = keyId] = item.split(':');
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
  ],
  exports: [
    HumanAuthService,
    AuthRateLimit,
    HumanSessionGuard,
    CsrfGuard,
    SessionCookieService,
    ApiKeyRegistry,
    ApiKeyGuard,
  ],
})
export class AuthModule {}
