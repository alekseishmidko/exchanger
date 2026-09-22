import type { PoolClient, QueryResultRow } from 'pg';
import { AccountId, AssetId, Decimal, OperationId, createId } from '../../../shared-kernel';
import type { OperationResult } from '../../domain/ledger';

export type CompensatableOperation = Readonly<{
  result: OperationResult;
  operationType: 'CREDIT' | 'DEBIT' | 'RESERVE' | 'RELEASE' | 'SETTLE_RESERVED_TRANSFER';
  accountId: AccountId;
  assetId: AssetId;
  amount: Decimal;
}>;

type OperationRow = QueryResultRow & { result: OperationResult };
type CompensatedOperationRow = OperationRow & {
  operation_type: CompensatableOperation['operationType'];
  account_id: string;
  asset_id: string;
  amount: string;
};

/**
 * Repository ledger operations/idempotency records.
 *
 * Сериализует concurrent retries по operationId через advisory lock и хранит
 * immutable public result, который возвращается при повторе без второго
 * денежного эффекта.
 */
export class LedgerOperationRepository {
  /** Блокирует operationId и возвращает прежний result, если операция уже была применена. */
  async lockExisting(client: PoolClient, id: OperationId): Promise<OperationResult | null> {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [id]);
    const existing = await client.query<OperationRow>(
      'SELECT result FROM ledger_operations WHERE operation_id=$1',
      [id],
    );
    return existing.rows[0]?.result ?? null;
  }

  /** Сохраняет immutable operation result после полного posting set. */
  async insert(
    client: PoolClient,
    id: OperationId,
    type: string,
    result: OperationResult,
    compensationFor?: OperationId,
  ): Promise<void> {
    await client.query(
      `INSERT INTO ledger_operations
        (operation_id, operation_type, result, compensation_for)
       VALUES ($1, $2, $3::jsonb, $4)`,
      [id, type, JSON.stringify(result), compensationFor ?? null],
    );
  }

  /** Находит базовую операцию, которую можно компенсировать generic reversal. */
  async findCompensatable(
    client: PoolClient,
    originalOperationId: OperationId,
  ): Promise<CompensatableOperation> {
    const original = await client.query<CompensatedOperationRow>(
      `SELECT o.result, o.operation_type, p.account_id, p.asset_id, p.amount::text
         FROM ledger_operations o
         JOIN postings p ON p.operation_id=o.operation_id AND p.account_id <> 'system'
        WHERE o.operation_id=$1
        ORDER BY p.id LIMIT 1
        FOR UPDATE OF o`,
      [originalOperationId],
    );
    const row = original.rows[0];
    if (!row) throw new Error('Original operation does not exist');
    return {
      result: row.result,
      operationType: row.operation_type,
      accountId: createId<'AccountId'>(row.account_id),
      assetId: createId<'AssetId'>(row.asset_id),
      amount: Decimal.from(row.amount),
    };
  }
}
