import { Global, Inject, Injectable, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { POSTGRES_POOL, POSTGRES_TRANSACTION } from './postgres.tokens';
import { PostgresTransactionManager } from './postgres-transaction';
import {
  ATOMIC_EXECUTION_PORT,
  DIRECT_ATOMIC_EXECUTION,
} from '../../modules/shared-kernel/atomic-execution.port';
import type { AtomicExecutionPort } from '../../modules/shared-kernel/atomic-execution.port';
import { PostgresAtomicExecution } from './postgres-atomic-execution';

/**
 * Закрывает PostgreSQL pool при graceful shutdown.
 *
 * Lifecycle wrapper не логирует connection string и не выполняет запросы. Он
 * гарантирует освобождение sockets как при штатной остановке, так и в тестах.
 */
@Injectable()
class PostgresPoolLifecycle implements OnApplicationShutdown {
  /**
   * Принимает принадлежащий модулю pool без копирования connection settings.
   * @param pool Единственный shared pool процесса.
   */
  constructor(@Inject(POSTGRES_POOL) private readonly pool: Pool) {}

  /** Завершает pool и ожидает возврата занятых соединений. */
  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * Глобальная infrastructure boundary PostgreSQL.
 *
 * Pool создаётся без сетевого подключения; фактическое соединение открывается
 * только durable adapter. Component runtime поэтому не требует локальной БД.
 * Production получает URL через `ConfigService.getOrThrow`, поскольку durable
 * adapter не имеет безопасного fallback.
 */
@Global()
@Module({
  providers: [
    {
      provide: POSTGRES_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Pool =>
        new Pool({
          connectionString: config.get<string>(
            'POSTGRES_URL',
            'postgres://postgres:postgres@127.0.0.1:5432/exchange',
          ),
          max: Number(config.get<string>('POSTGRES_POOL_MAX', '10')),
          connectionTimeoutMillis: Number(
            config.get<string>('POSTGRES_CONNECTION_TIMEOUT_MS', '2000'),
          ),
          idleTimeoutMillis: Number(config.get<string>('POSTGRES_IDLE_TIMEOUT_MS', '30000')),
          query_timeout: Number(config.get<string>('POSTGRES_QUERY_TIMEOUT_MS', '2000')),
          application_name: config.get<string>('SERVICE_NAME', 'exchange-backend'),
        }),
    },
    {
      provide: POSTGRES_TRANSACTION,
      inject: [POSTGRES_POOL],
      useFactory: (pool: Pool): PostgresTransactionManager => new PostgresTransactionManager(pool),
    },
    {
      provide: ATOMIC_EXECUTION_PORT,
      inject: [ConfigService, POSTGRES_TRANSACTION],
      useFactory: (
        config: ConfigService,
        transactions: PostgresTransactionManager,
      ): AtomicExecutionPort =>
        config.getOrThrow<string>('RUNTIME_PROFILE') === 'component'
          ? DIRECT_ATOMIC_EXECUTION
          : new PostgresAtomicExecution(transactions),
    },
    PostgresPoolLifecycle,
  ],
  exports: [POSTGRES_POOL, POSTGRES_TRANSACTION, ATOMIC_EXECUTION_PORT],
})
export class PostgresModule {}
