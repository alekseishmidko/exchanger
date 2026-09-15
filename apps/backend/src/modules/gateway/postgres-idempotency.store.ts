import { ConflictException, Inject } from '@nestjs/common';
import type { QueryResultRow } from 'pg';
import { POSTGRES_TRANSACTION, PostgresTransactionManager } from '../../infrastructure/postgres';
import { sha256 } from '../../infrastructure/postgres/postgres-json';
import type { IdempotencyStorePort } from './gateway.idempotency.port';

type IdempotencyRow = QueryResultRow & {
  payload_hash: string;
  status: 'PENDING' | 'APPLIED' | 'REJECTED';
  public_result: unknown;
};

/**
 * PostgreSQL adapter атомарной идемпотентности HTTP-команд.
 *
 * Adapter сохраняет только digest исходного key, identity scope и hash payload.
 * Первая transaction вставляет `PENDING`, выполняет callback в том же
 * `PoolClient` через `PostgresTransactionManager`, сохраняет public result и
 * commit-ит всё вместе. Concurrent INSERT конфликтует по primary key и ждёт
 * первую transaction; затем повтор возвращает уже committed результат.
 *
 * Crash до commit откатывает и idempotency row, и вложенный command/outbox.
 * Crash после commit оставляет `APPLIED`, поэтому повтор после restart не
 * создаёт второй business effect.
 */
export class PostgresIdempotencyStore implements IdempotencyStorePort {
  /**
   * Создаёт adapter поверх shared transaction manager.
   * @param transactions Менеджер, объединяющий command и idempotency commit.
   */
  constructor(
    @Inject(POSTGRES_TRANSACTION) private readonly transactions: PostgresTransactionManager,
  ) {}

  /**
   * Выполняет callback не более одного раза для одной пары identity/key.
   *
   * @param key Scoped строка в формате `identity:idempotency-key`.
   * @param request Нормализованная команда для payload hash.
   * @param operation Команда, использующая тот же transaction context.
   * @returns Новый либо ранее committed public result.
   * @throws ConflictException При повторе key с другим payload или stale pending.
   */
  execute<T>(key: string, request: unknown, operation: () => Promise<T>): Promise<T> {
    return this.transactions.run(async (client) => {
      const { identity, rawKey } = this.splitScopedKey(key);
      const keyDigest = sha256(rawKey);
      const payloadHash = sha256(request);
      const inserted = await client.query(
        `INSERT INTO api_idempotency_records
          (identity_key, key_digest, payload_hash, status)
         VALUES ($1, $2, $3, 'PENDING')
         ON CONFLICT DO NOTHING
         RETURNING identity_key`,
        [identity, keyDigest, payloadHash],
      );

      if (inserted.rowCount === 0) {
        const existing = await client.query<IdempotencyRow>(
          `SELECT payload_hash, status, public_result
             FROM api_idempotency_records
            WHERE identity_key = $1 AND key_digest = $2
            FOR UPDATE`,
          [identity, keyDigest],
        );
        const row = existing.rows[0];
        if (!row || row.payload_hash !== payloadHash) {
          throw new ConflictException({
            code: 'IDEMPOTENCY_KEY_REUSED',
            message: 'Idempotency key was reused with another request',
          });
        }
        if (row.status === 'APPLIED') return row.public_result as T;
        throw new ConflictException({
          code: 'IDEMPOTENCY_OPERATION_PENDING',
          message: 'Previous operation has not reached a terminal state',
        });
      }

      const result = await operation();
      const commandId = this.commandId(result);
      await client.query(
        `UPDATE api_idempotency_records
            SET status = 'APPLIED', public_result = $3::jsonb, command_id = $4,
                updated_at = clock_timestamp()
          WHERE identity_key = $1 AND key_digest = $2`,
        [identity, keyDigest, JSON.stringify(result), commandId],
      );
      return result;
    });
  }

  /** Разделяет identity и raw key, не записывая raw key в PostgreSQL. */
  private splitScopedKey(value: string): Readonly<{ identity: string; rawKey: string }> {
    const separator = value.indexOf(':');
    if (separator < 1 || separator === value.length - 1) {
      throw new Error('SCOPED_IDEMPOTENCY_KEY_REQUIRED');
    }
    return { identity: value.slice(0, separator), rawKey: value.slice(separator + 1) };
  }

  /** Извлекает commandId только из публичного object result. */
  private commandId(result: unknown): string | null {
    if (
      typeof result === 'object' &&
      result !== null &&
      'commandId' in result &&
      typeof result.commandId === 'string'
    ) {
      return result.commandId;
    }
    return null;
  }
}
