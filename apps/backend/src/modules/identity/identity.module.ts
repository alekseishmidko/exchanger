import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Pool } from 'pg';
import {
  POSTGRES_POOL,
  POSTGRES_TRANSACTION,
  PostgresTransactionManager,
} from '../../infrastructure/postgres';
import { AuditModule } from '../audit';
import { IdentityService } from './application/identity.service';
import { AdminSessionsController } from './controllers/admin-sessions.controller';
import { UserAuthenticationController } from './controllers/auth.controller';
import { UsersSelfServiceController } from './controllers/users.controller';
import { MemorySessionStore, MemoryUserStore } from './infrastructure/memory-identity.stores';
import { PostgresUserStore } from './infrastructure/postgres-user.store';
import { RedisSessionStore } from './infrastructure/redis-session.store';
import { SESSION_STORE, SessionStore, USER_STORE, UserStore } from './ports/identity.ports';
import { CsrfGuard } from './security/csrf.guard';
import { HumanSessionGuard } from './security/human-session.guard';
import { PasswordHasher } from './security/password-hasher';
import { AuthRateLimit } from './security/auth-rate-limit';
import { SessionCookieService } from './security/session-cookie.service';
import { HttpsRecoveryDelivery, MemoryRecoveryDelivery } from './infrastructure/recovery-delivery';
import { RECOVERY_DELIVERY, RecoveryDelivery } from './ports/identity.ports';
import { IdentityRetentionService } from './infrastructure/identity-retention.service';
import {
  IDEMPOTENCY_STORE_PORT,
  IdempotencyStorePort,
} from '../gateway/ports/gateway.idempotency.port';
import { IdempotencyStore } from '../gateway/application/gateway.idempotency';
import { PostgresIdempotencyStore } from '../gateway/infrastructure/postgres-idempotency.store';

/**
 * Composition root пользовательской identity.
 * Только component profile получает memory stores; staging/production всегда
 * создают PostgreSQL user repository и Redis session source of truth.
 */
@Module({
  imports: [AuditModule],
  controllers: [UserAuthenticationController, UsersSelfServiceController, AdminSessionsController],
  providers: [
    MemoryUserStore,
    MemorySessionStore,
    MemoryRecoveryDelivery,
    PasswordHasher,
    AuthRateLimit,
    IdentityService,
    IdentityRetentionService,
    HumanSessionGuard,
    CsrfGuard,
    SessionCookieService,
    {
      provide: IDEMPOTENCY_STORE_PORT,
      inject: [ConfigService, POSTGRES_TRANSACTION],
      useFactory: (
        config: ConfigService,
        transactions: PostgresTransactionManager,
      ): IdempotencyStorePort =>
        config.getOrThrow('RUNTIME_PROFILE') === 'component'
          ? new IdempotencyStore()
          : new PostgresIdempotencyStore(transactions),
    },
    {
      provide: USER_STORE,
      inject: [ConfigService, MemoryUserStore, POSTGRES_POOL],
      useFactory: (config: ConfigService, memory: MemoryUserStore, pool: Pool): UserStore =>
        config.getOrThrow('RUNTIME_PROFILE') === 'component' ? memory : new PostgresUserStore(pool),
    },
    {
      provide: RECOVERY_DELIVERY,
      inject: [ConfigService, MemoryRecoveryDelivery],
      useFactory: (config: ConfigService, memory: MemoryRecoveryDelivery): RecoveryDelivery =>
        config.getOrThrow('RUNTIME_PROFILE') === 'component'
          ? memory
          : new HttpsRecoveryDelivery(config),
    },
    {
      provide: SESSION_STORE,
      inject: [ConfigService, MemorySessionStore],
      useFactory: (config: ConfigService, memory: MemorySessionStore): SessionStore =>
        config.getOrThrow('RUNTIME_PROFILE') === 'component'
          ? memory
          : new RedisSessionStore(config),
    },
  ],
  exports: [IdentityService, HumanSessionGuard, CsrfGuard, SESSION_STORE],
})
export class IdentityModule {}
