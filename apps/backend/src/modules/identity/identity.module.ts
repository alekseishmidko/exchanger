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
    /** Component implementation user storage без внешней базы. */
    MemoryUserStore,
    /** Component implementation session storage с теми же port semantics. */
    MemorySessionStore,
    /** Перехватывает recovery delivery в tests, не отправляя внешние сообщения. */
    MemoryRecoveryDelivery,
    /** Удаляет истёкшие identity records согласно retention policy. */
    IdentityRetentionService,
    /** Выбирает memory либо PostgreSQL user repository по runtime profile. */
    {
      provide: USER_STORE,
      inject: [ConfigService, MemoryUserStore, POSTGRES_POOL],
      useFactory: (config: ConfigService, memory: MemoryUserStore, pool: Pool): UserStore =>
        config.getOrThrow('RUNTIME_PROFILE') === 'component' ? memory : new PostgresUserStore(pool),
    },
    /** Выбирает test delivery либо HTTPS delivery для recovery token. */
    {
      provide: RECOVERY_DELIVERY,
      inject: [ConfigService, MemoryRecoveryDelivery],
      useFactory: (config: ConfigService, memory: MemoryRecoveryDelivery): RecoveryDelivery =>
        config.getOrThrow('RUNTIME_PROFILE') === 'component'
          ? memory
          : new HttpsRecoveryDelivery(config),
    },
    /** Выбирает локальные sessions либо shared Redis session store. */
    {
      provide: SESSION_STORE,
      inject: [ConfigService, MemorySessionStore],
      useFactory: (config: ConfigService, memory: MemorySessionStore): SessionStore =>
        config.getOrThrow('RUNTIME_PROFILE') === 'component'
          ? memory
          : new RedisSessionStore(config),
    },
  ],
  /** AuthModule получает storage ports; memory delivery экспортируется для test assertions. */
  exports: [USER_STORE, SESSION_STORE, RECOVERY_DELIVERY, MemoryRecoveryDelivery],
})
export class IdentityModule {}
