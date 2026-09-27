import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Pool } from 'pg';
import { POSTGRES_POOL } from '../../infrastructure/postgres';
import { IdentityRetentionService } from './infrastructure/identity-retention.service';
import { MemorySessionStore, MemoryUserStore } from './infrastructure/memory-identity.stores';
import { PostgresUserStore } from './infrastructure/postgres-user.store';
import { HttpsRecoveryDelivery, MemoryRecoveryDelivery } from './infrastructure/recovery-delivery';
import { RedisSessionStore } from './infrastructure/redis-session.store';
import {
  RECOVERY_DELIVERY,
  RecoveryDelivery,
  SESSION_STORE,
  SessionStore,
  USER_STORE,
  UserStore,
} from './ports/identity.ports';

/**
 * Persistence boundary пользовательской identity.
 *
 * Модуль владеет профилями и хранилищами users/sessions. Authentication use
 * cases, credentials, guards, DTO и runtime validation принадлежат AuthModule.
 */
@Module({
  providers: [
    MemoryUserStore,
    MemorySessionStore,
    MemoryRecoveryDelivery,
    IdentityRetentionService,
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
  exports: [USER_STORE, SESSION_STORE, RECOVERY_DELIVERY, MemoryRecoveryDelivery],
})
export class IdentityModule {}
