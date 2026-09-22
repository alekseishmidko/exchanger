import type { PoolClient, QueryResultRow } from 'pg';
import { AccountId, AssetId, Decimal, createId } from '../../../shared-kernel';
import { Balance } from '../../domain/balance';

type BalanceRow = QueryResultRow & { available: string; reserved: string };
type LedgerMutationType = 'CREDIT' | 'DEBIT' | 'RESERVE' | 'RELEASE';

/**
 * Repository balances available/reserved.
 *
 * Класс содержит SQL, который меняет денежные остатки, и не отвечает за
 * operationId/idempotency/postings. Эти атомарные правила координирует adapter.
 */
export class LedgerBalanceRepository {
  /** Открывает нулевой balance для существующей пары account/asset. */
  async open(client: PoolClient, accountId: AccountId, assetId: AssetId): Promise<void> {
    await client.query(
      `INSERT INTO balances (account_id, asset_id, available, reserved)
       VALUES ($1, $2, 0, 0) ON CONFLICT DO NOTHING`,
      [accountId, assetId],
    );
  }

  /** Возвращает assets открытых balances account в детерминированном порядке. */
  async listAssetIds(client: PoolClient, accountId: AccountId): Promise<readonly AssetId[]> {
    const result = await client.query<{ asset_id: string }>(
      'SELECT asset_id FROM balances WHERE account_id=$1 ORDER BY asset_id',
      [accountId],
    );
    return result.rows.map((row) => createId<'AssetId'>(row.asset_id));
  }

  /** Читает NUMERIC values и восстанавливает проверенный Balance value object. */
  async get(client: PoolClient, accountId: AccountId, assetId: AssetId): Promise<Balance> {
    const result = await client.query<BalanceRow>(
      'SELECT available::text, reserved::text FROM balances WHERE account_id=$1 AND asset_id=$2',
      [accountId, assetId],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Balance does not exist');
    return Balance.restore(Decimal.from(row.available), Decimal.from(row.reserved));
  }

  /** Применяет одиночную credit/debit/reserve/release mutation с SQL predicate. */
  async applyMutation(
    client: PoolClient,
    type: LedgerMutationType,
    account: AccountId,
    asset: AssetId,
    amount: Decimal,
  ): Promise<void> {
    const sql = {
      CREDIT: 'UPDATE balances SET available=available+$3 WHERE account_id=$1 AND asset_id=$2',
      DEBIT:
        'UPDATE balances SET available=available-$3 WHERE account_id=$1 AND asset_id=$2 AND available >= $3',
      RESERVE:
        'UPDATE balances SET available=available-$3, reserved=reserved+$3 WHERE account_id=$1 AND asset_id=$2 AND available >= $3',
      RELEASE:
        'UPDATE balances SET available=available+$3, reserved=reserved-$3 WHERE account_id=$1 AND asset_id=$2 AND reserved >= $3',
    }[type];
    const changed = await client.query(sql, [account, asset, amount.toString()]);
    if (changed.rowCount !== 1) throw new Error(`Ledger ${type} invariant violation`);
  }

  /** Блокирует balances двух accounts в стабильном порядке для transfer. */
  async lockTransferBalances(
    client: PoolClient,
    debit: AccountId,
    credit: AccountId,
    asset: AssetId,
  ): Promise<void> {
    await client.query(
      `SELECT account_id FROM balances
        WHERE asset_id=$1 AND account_id = ANY($2::text[])
        ORDER BY account_id FOR UPDATE`,
      [asset, [debit, credit]],
    );
  }

  /** Списывает reserved источника при settlement. */
  async debitReserved(
    client: PoolClient,
    account: AccountId,
    asset: AssetId,
    amount: Decimal,
  ): Promise<void> {
    const source = await client.query(
      `UPDATE balances SET reserved = reserved - $3
        WHERE account_id=$1 AND asset_id=$2 AND reserved >= $3`,
      [account, asset, amount.toString()],
    );
    if (source.rowCount !== 1) throw new Error('Insufficient reserved balance');
  }

  /** Увеличивает available получателя settlement transfer. */
  async creditAvailable(
    client: PoolClient,
    account: AccountId,
    asset: AssetId,
    amount: Decimal,
  ): Promise<void> {
    const target = await client.query(
      'UPDATE balances SET available = available + $3 WHERE account_id=$1 AND asset_id=$2',
      [account, asset, amount.toString()],
    );
    if (target.rowCount !== 1) throw new Error('Balance does not exist');
  }
}
