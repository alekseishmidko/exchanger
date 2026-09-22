import type { PoolClient } from 'pg';
import type { AccountId } from '../../../shared-kernel';
import type { Account } from '../../domain/asset-account';

/**
 * Repository ledger accounts и immutable owner binding.
 *
 * Account ownership используется Gateway/Application layer для object-level
 * authorization, поэтому repository возвращает только ownerId и не читает
 * финансовые balances/postings.
 */
export class LedgerAccountRepository {
  /** Создаёт account с неизменяемым владельцем. */
  async register(client: PoolClient, account: Account): Promise<void> {
    await client.query('INSERT INTO accounts (id, owner_id) VALUES ($1, $2)', [
      account.id,
      account.ownerId,
    ]);
  }

  /** Возвращает owner binding либо `null`, если account отсутствует. */
  async getOwner(client: PoolClient, accountId: AccountId): Promise<string | null> {
    const result = await client.query<{ owner_id: string }>(
      'SELECT owner_id FROM accounts WHERE id=$1',
      [accountId],
    );
    return result.rows[0]?.owner_id ?? null;
  }

  /** Создаёт технический system account для второй стороны external credit/debit. */
  async ensureSystemAccount(client: PoolClient): Promise<void> {
    await client.query(
      "INSERT INTO accounts (id, owner_id) VALUES ('system', 'system') ON CONFLICT DO NOTHING",
    );
  }
}
