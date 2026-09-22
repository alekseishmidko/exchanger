import type { PoolClient } from 'pg';
import { AccountId, AssetId, Decimal, OperationId } from '../../../shared-kernel';

/**
 * Repository immutable double-entry postings.
 *
 * Вставляет только полный balanced pair: одна DEBIT и одна CREDIT строка. Проверка
 * равенства сумм дополнительно enforced database trigger-ом на commit.
 */
export class LedgerPostingRepository {
  /** Вставляет две равные разнонаправленные immutable проводки. */
  async insertPair(
    client: PoolClient,
    id: OperationId,
    debit: AccountId,
    credit: AccountId,
    asset: AssetId,
    amount: Decimal,
  ): Promise<void> {
    await client.query(
      `INSERT INTO postings (id, operation_id, account_id, asset_id, direction, amount)
       VALUES ($1, $3, $4, $5, 'DEBIT', $6), ($2, $3, $7, $5, 'CREDIT', $6)`,
      [`${id}-debit`, `${id}-credit`, id, debit, asset, amount.toString(), credit],
    );
  }
}
