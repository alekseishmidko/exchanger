import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool, PoolClient } from 'pg';

/** Параметры bounded retry для transient PostgreSQL conflicts. */
export type TransactionRetryPolicy = Readonly<{
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}>;

/** SQLSTATE, при которых повтор всей транзакции безопасен. */
const retryableSqlStates = new Set(['40001', '40P01', '55P03']);

/**
 * Менеджер вложенного транзакционного контекста PostgreSQL.
 *
 * `AsyncLocalStorage` позволяет нескольким adapters участвовать в одной ACID
 * transaction без передачи `PoolClient` через application interfaces. Внешний
 * вызов открывает transaction, а вложенные `run` переиспользуют текущий client.
 * Это связывает idempotency row, command journal и outbox атомарно.
 *
 * Transient serialization/deadlock/lock errors повторяют всю функцию с bounded
 * exponential backoff и детерминированным ограниченным jitter. Business errors
 * и неизвестные SQLSTATE не повторяются.
 */
export class PostgresTransactionManager {
  private readonly storage = new AsyncLocalStorage<PoolClient>();

  /**
   * Создаёт менеджер для единственного shared pool.
   * @param pool Пул соединений, lifecycle которого принадлежит NestJS module.
   */
  constructor(private readonly pool: Pool) {}

  /**
   * Выполняет callback в transaction либо переиспользует текущую transaction.
   *
   * @param operation Работа, которая должна commit/rollback как единое целое.
   * @param policy Bounded retry; по умолчанию максимум три попытки.
   * @returns Результат callback только после успешного `COMMIT`.
   * @throws Последняя ошибка после исчерпания retry budget.
   */
  async run<T>(
    operation: (client: PoolClient) => Promise<T>,
    policy: TransactionRetryPolicy = { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100 },
  ): Promise<T> {
    const existing = this.storage.getStore();
    if (existing) return operation(existing);

    let lastError: unknown;
    for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const result = await this.storage.run(client, () => operation(client));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        lastError = error;
        await client.query('ROLLBACK').catch(() => undefined);
        if (!this.isRetryable(error) || attempt === policy.maxAttempts) throw error;
        await this.delay(this.backoff(attempt, policy));
      } finally {
        client.release();
      }
    }
    throw lastError;
  }

  /**
   * Возвращает client текущей transaction.
   * @throws Error Если adapter вызван вне `run` и атомарность не гарантирована.
   */
  currentClient(): PoolClient {
    const client = this.storage.getStore();
    if (!client) throw new Error('POSTGRES_TRANSACTION_CONTEXT_REQUIRED');
    return client;
  }

  /** Определяет transient conflict только по allow-list SQLSTATE. */
  private isRetryable(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string' &&
      retryableSqlStates.has(error.code)
    );
  }

  /** Вычисляет bounded exponential backoff с малым process-local jitter. */
  private backoff(attempt: number, policy: TransactionRetryPolicy): number {
    const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
    const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(exponential / 4)));
    return Math.min(policy.maxDelayMs, exponential + jitter);
  }

  /** Не блокирует event loop во время ожидания следующей попытки. */
  private delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
}
