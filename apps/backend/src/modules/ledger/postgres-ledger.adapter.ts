import { Inject } from '@nestjs/common';
import type { PoolClient, QueryResultRow } from 'pg';
import { POSTGRES_TRANSACTION, PostgresTransactionManager } from '../../infrastructure/postgres';
import { AccountId, AssetId, Decimal, OperationId, createId } from '../shared-kernel';
import type { Account, Asset } from './asset-account';
import { Balance } from './balance';
import type { OperationResult } from './ledger';
import type { LedgerPort } from './ledger.port';

type BalanceRow = QueryResultRow & { available: string; reserved: string };
type OperationRow = QueryResultRow & { result: OperationResult };
type CompensatedOperationRow = OperationRow & {
  operation_type: 'CREDIT' | 'DEBIT' | 'RESERVE' | 'RELEASE' | 'SETTLE_RESERVED_TRANSFER';
  account_id: string;
  asset_id: string;
  amount: string;
};

/**
 * PostgreSQL adapter двойной записи и available/reserved balances.
 *
 * Каждая mutation берёт transaction-level lock по operationId, проверяет
 * прежний result, блокирует balance rows и одной transaction фиксирует balances,
 * полный posting set, operation record и reservation state. SQL predicates не
 * допускают отрицательный available/reserved даже при конкурентных запросах.
 * Deferred constraint trigger проверяет равенство debit/credit при commit.
 */
export class PostgresLedgerAdapter implements LedgerPort {
  /**
   * Создаёт adapter поверх shared transaction manager.
   * @param transactions Менеджер внешней command/idempotency transaction.
   */
  constructor(
    @Inject(POSTGRES_TRANSACTION) private readonly transactions: PostgresTransactionManager,
  ) {}

  /**
   * Регистрирует asset, отклоняя изменение уже опубликованной precision.
   * Повтор идентичного definition безопасен, но тот же ID с другим code/scale
   * возвращает `ASSET_DEFINITION_CONFLICT`.
   * @param asset Проверенный immutable asset definition.
   */
  registerAsset(asset: Asset): Promise<void> {
    return this.transactions.run(async (client) => {
      const result = await client.query(
        `INSERT INTO assets (id, code, scale) VALUES ($1, $2, $3)
         ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
         WHERE assets.code = EXCLUDED.code AND assets.scale = EXCLUDED.scale`,
        [asset.id, asset.code, asset.scale],
      );
      if (result.rowCount === 0) throw new Error('ASSET_DEFINITION_CONFLICT');
    });
  }

  /**
   * Регистрирует account, сохраняя immutable owner binding.
   * @param account Новый account; duplicate ID отклоняется database constraint.
   */
  registerAccount(account: Account): Promise<void> {
    return this.transactions.run(async (client) => {
      await client.query('INSERT INTO accounts (id, owner_id) VALUES ($1, $2)', [
        account.id,
        account.ownerId,
      ]);
    });
  }

  /**
   * Читает owner binding для object-level authorization.
   * @returns Owner ID либо `null`; финансовые значения этим запросом не читаются.
   */
  getAccountOwner(accountId: AccountId): Promise<string | null> {
    return this.transactions.run(async (client) => {
      const result = await client.query<{ owner_id: string }>(
        'SELECT owner_id FROM accounts WHERE id=$1',
        [accountId],
      );
      return result.rows[0]?.owner_id ?? null;
    });
  }

  /**
   * Идемпотентно открывает нулевой balance существующей пары account/asset.
   * Foreign keys гарантируют, что неизвестный account или asset не создастся
   * неявно.
   */
  openBalance(accountId: AccountId, assetId: AssetId): Promise<void> {
    return this.transactions.run(async (client) => {
      await client.query(
        `INSERT INTO balances (account_id, asset_id, available, reserved)
         VALUES ($1, $2, 0, 0) ON CONFLICT DO NOTHING`,
        [accountId, assetId],
      );
    });
  }

  /** Возвращает typed asset IDs account в детерминированном порядке. */
  listBalanceAssetIds(accountId: AccountId): Promise<readonly AssetId[]> {
    return this.transactions.run(async (client) => {
      const result = await client.query<{ asset_id: string }>(
        'SELECT asset_id FROM balances WHERE account_id=$1 ORDER BY asset_id',
        [accountId],
      );
      return result.rows.map((row) => createId<'AssetId'>(row.asset_id));
    });
  }

  /**
   * Читает точные NUMERIC values и восстанавливает проверенный `Balance`.
   * @throws Error Если balance отсутствует либо сохранённые значения нарушают invariant.
   */
  getBalance(accountId: AccountId, assetId: AssetId): Promise<Balance> {
    return this.transactions.run(async (client) => {
      const result = await client.query<BalanceRow>(
        'SELECT available::text, reserved::text FROM balances WHERE account_id=$1 AND asset_id=$2',
        [accountId, assetId],
      );
      const row = result.rows[0];
      if (!row) throw new Error('Balance does not exist');
      return Balance.restore(Decimal.from(row.available), Decimal.from(row.reserved));
    });
  }

  /**
   * Идемпотентно увеличивает available и создаёт две balanced postings.
   * @example Повтор `credit-42` возвращает прежние posting IDs без второго начисления.
   */
  credit(id: OperationId, account: AccountId, asset: AssetId, amount: Decimal) {
    return this.mutate(id, 'CREDIT', account, asset, amount);
  }

  /** Идемпотентно уменьшает available только при достаточном остатке. */
  debit(id: OperationId, account: AccountId, asset: AssetId, amount: Decimal) {
    return this.mutate(id, 'DEBIT', account, asset, amount);
  }

  /** Идемпотентно перемещает amount из available в reserved без изменения total. */
  reserve(id: OperationId, account: AccountId, asset: AssetId, amount: Decimal) {
    return this.mutate(id, 'RESERVE', account, asset, amount);
  }

  /** Освобождает active reservation новой operation, не удаляя исходную запись. */
  release(id: OperationId, account: AccountId, asset: AssetId, amount: Decimal) {
    return this.mutate(id, 'RELEASE', account, asset, amount);
  }

  /**
   * Переводит reserved источника в available получателя в одной transaction.
   * Locks берутся по стабильному accountId-порядку для снижения deadlock risk.
   * @returns Идемпотентный result с двумя immutable posting IDs.
   * @throws Error Если source reserve или target balance отсутствует.
   */
  settleReservedTransfer(
    id: OperationId,
    debit: AccountId,
    credit: AccountId,
    asset: AssetId,
    amount: Decimal,
  ): Promise<OperationResult> {
    return this.transactions.run(async (client) => {
      const previous = await this.lockOperation(client, id);
      if (previous) return previous;
      this.requirePositive(amount);
      await client.query(
        `SELECT account_id FROM balances
          WHERE asset_id=$1 AND account_id = ANY($2::text[])
          ORDER BY account_id FOR UPDATE`,
        [asset, [debit, credit]],
      );
      const source = await client.query(
        `UPDATE balances SET reserved = reserved - $3
          WHERE account_id=$1 AND asset_id=$2 AND reserved >= $3`,
        [debit, asset, amount.toString()],
      );
      if (source.rowCount !== 1) throw new Error('Insufficient reserved balance');
      const target = await client.query(
        'UPDATE balances SET available = available + $3 WHERE account_id=$1 AND asset_id=$2',
        [credit, asset, amount.toString()],
      );
      if (target.rowCount !== 1) throw new Error('Balance does not exist');
      const result = this.result(id);
      await this.insertPostings(client, id, debit, credit, asset, amount);
      await this.insertOperation(client, id, 'SETTLE_RESERVED_TRANSFER', result);
      const reservation = await client.query(
        `UPDATE reservations
            SET remaining_amount=remaining_amount-$3,
                status=CASE WHEN remaining_amount-$3=0 THEN 'SETTLED' ELSE 'ACTIVE' END,
                updated_at=clock_timestamp()
          WHERE reservation_id = (
            SELECT reservation_id FROM reservations
             WHERE account_id=$1 AND asset_id=$2 AND status='ACTIVE' AND remaining_amount >= $3
             ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
          )`,
        [debit, asset, amount.toString()],
      );
      if (reservation.rowCount !== 1) throw new Error('Active reservation does not exist');
      return result;
    });
  }

  /**
   * Компенсирует базовую ledger mutation новой связанной operation.
   * Settlement compensation требует отдельной posting matrix и намеренно
   * отклоняется, чтобы generic reversal не нарушил reserved/fee semantics.
   */
  compensate(
    compensationId: OperationId,
    originalOperationId: OperationId,
  ): Promise<OperationResult> {
    return this.transactions.run(async (client) => {
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
      if (row.operation_type === 'SETTLE_RESERVED_TRANSFER') {
        throw new Error('Settlement requires explicit compensation matrix');
      }
      const inverse = {
        CREDIT: 'DEBIT',
        DEBIT: 'CREDIT',
        RESERVE: 'RELEASE',
        RELEASE: 'RESERVE',
      }[row.operation_type] as 'CREDIT' | 'DEBIT' | 'RESERVE' | 'RELEASE';
      return this.mutate(
        compensationId,
        inverse,
        createId<'AccountId'>(row.account_id),
        createId<'AssetId'>(row.asset_id),
        Decimal.from(row.amount),
        originalOperationId,
      );
    });
  }

  /** Выполняет credit/debit/reserve/release по единому atomic шаблону. */
  private mutate(
    id: OperationId,
    type: 'CREDIT' | 'DEBIT' | 'RESERVE' | 'RELEASE',
    account: AccountId,
    asset: AssetId,
    amount: Decimal,
    compensationFor?: OperationId,
  ): Promise<OperationResult> {
    return this.transactions.run(async (client) => {
      const previous = await this.lockOperation(client, id);
      if (previous) return previous;
      this.requirePositive(amount);
      await this.ensureSystemAccount(client);
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
      const result = this.result(id);
      const accountDirection = type === 'CREDIT' || type === 'RELEASE' ? 'CREDIT' : 'DEBIT';
      await this.insertPostings(
        client,
        id,
        accountDirection === 'DEBIT' ? account : createId<'AccountId'>('system'),
        accountDirection === 'CREDIT' ? account : createId<'AccountId'>('system'),
        asset,
        amount,
      );
      await this.insertOperation(client, id, type, result, compensationFor);
      if (type === 'RESERVE') {
        await client.query(
          `INSERT INTO reservations
            (reservation_id, operation_id, account_id, asset_id, amount, remaining_amount, status)
           VALUES ($1, $1, $2, $3, $4, $4, 'ACTIVE')`,
          [id, account, asset, amount.toString()],
        );
      }
      if (type === 'RELEASE') {
        const reservation = await client.query(
          `UPDATE reservations
              SET remaining_amount=remaining_amount-$4,
                  status=CASE WHEN remaining_amount-$4=0 THEN 'RELEASED' ELSE 'ACTIVE' END,
                  release_operation_id=$3,
                  updated_at=clock_timestamp()
            WHERE reservation_id = (
              SELECT reservation_id FROM reservations
               WHERE account_id=$1 AND asset_id=$2 AND status='ACTIVE' AND remaining_amount >= $4
               ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
            )`,
          [account, asset, id, amount.toString()],
        );
        if (reservation.rowCount !== 1) throw new Error('Active reservation does not exist');
      }
      return result;
    });
  }

  /** Сериализует concurrent retries operationId и возвращает прежний result. */
  private async lockOperation(
    client: PoolClient,
    id: OperationId,
  ): Promise<OperationResult | null> {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [id]);
    const existing = await client.query<OperationRow>(
      'SELECT result FROM ledger_operations WHERE operation_id=$1',
      [id],
    );
    return existing.rows[0]?.result ?? null;
  }

  /** Создаёт технический account для второй стороны external credit/debit. */
  private async ensureSystemAccount(client: PoolClient): Promise<void> {
    await client.query(
      "INSERT INTO accounts (id, owner_id) VALUES ('system', 'system') ON CONFLICT DO NOTHING",
    );
  }

  /** Вставляет две равные разнонаправленные immutable проводки. */
  private async insertPostings(
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

  /** Сохраняет immutable operation result после полного posting set. */
  private async insertOperation(
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

  /** Формирует детерминированные posting IDs для retry/reconciliation. */
  private result(id: OperationId): OperationResult {
    return {
      operationId: id,
      postingIds: [createId<'PostingId'>(`${id}-debit`), createId<'PostingId'>(`${id}-credit`)],
    };
  }

  /** Запрещает нулевые и отрицательные денежные mutations до SQL. */
  private requirePositive(amount: Decimal): void {
    if (amount.isZero() || amount.isNegative()) throw new Error('Amount must be positive');
  }
}
