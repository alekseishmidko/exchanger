import { Inject } from '@nestjs/common';
import { POSTGRES_TRANSACTION, PostgresTransactionManager } from '../../../infrastructure/postgres';
import { AccountId, AssetId, Decimal, OperationId, createId } from '../../shared-kernel';
import type { Account, Asset } from '../domain/asset-account';
import type { OperationResult } from '../domain/ledger';
import type { LedgerPort } from '../ports/ledger.port';
import {
  LedgerAccountRepository,
  LedgerAssetRepository,
  LedgerBalanceRepository,
  LedgerOperationRepository,
  LedgerPostingRepository,
  LedgerReservationRepository,
} from './repositories';

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
  private readonly accounts = new LedgerAccountRepository();
  private readonly assets = new LedgerAssetRepository();
  private readonly balances = new LedgerBalanceRepository();
  private readonly operations = new LedgerOperationRepository();
  private readonly postings = new LedgerPostingRepository();
  private readonly reservations = new LedgerReservationRepository();

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
    return this.transactions.run((client) => this.assets.register(client, asset));
  }

  /**
   * Регистрирует account, сохраняя immutable owner binding.
   * @param account Новый account; duplicate ID отклоняется database constraint.
   */
  registerAccount(account: Account): Promise<void> {
    return this.transactions.run((client) => this.accounts.register(client, account));
  }

  /**
   * Читает owner binding для object-level authorization.
   * @returns Owner ID либо `null`; финансовые значения этим запросом не читаются.
   */
  getAccountOwner(accountId: AccountId): Promise<string | null> {
    return this.transactions.run((client) => this.accounts.getOwner(client, accountId));
  }

  /**
   * Идемпотентно открывает нулевой balance существующей пары account/asset.
   * Foreign keys гарантируют, что неизвестный account или asset не создастся
   * неявно.
   */
  openBalance(accountId: AccountId, assetId: AssetId): Promise<void> {
    return this.transactions.run((client) => this.balances.open(client, accountId, assetId));
  }

  /** Возвращает typed asset IDs account в детерминированном порядке. */
  listBalanceAssetIds(accountId: AccountId): Promise<readonly AssetId[]> {
    return this.transactions.run((client) => this.balances.listAssetIds(client, accountId));
  }

  /**
   * Читает точные NUMERIC values и восстанавливает проверенный `Balance`.
   * @throws Error Если balance отсутствует либо сохранённые значения нарушают invariant.
   */
  getBalance(accountId: AccountId, assetId: AssetId) {
    return this.transactions.run((client) => this.balances.get(client, accountId, assetId));
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
      const previous = await this.operations.lockExisting(client, id);
      if (previous) return previous;
      this.requirePositive(amount);
      await this.balances.lockTransferBalances(client, debit, credit, asset);
      await this.balances.debitReserved(client, debit, asset, amount);
      await this.balances.creditAvailable(client, credit, asset, amount);
      const result = this.result(id);
      await this.postings.insertPair(client, id, debit, credit, asset, amount);
      await this.operations.insert(client, id, 'SETTLE_RESERVED_TRANSFER', result);
      await this.reservations.settle(client, debit, asset, amount);
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
      const original = await this.operations.findCompensatable(client, originalOperationId);
      if (original.operationType === 'SETTLE_RESERVED_TRANSFER') {
        throw new Error('Settlement requires explicit compensation matrix');
      }
      const inverse = {
        CREDIT: 'DEBIT',
        DEBIT: 'CREDIT',
        RESERVE: 'RELEASE',
        RELEASE: 'RESERVE',
      }[original.operationType] as 'CREDIT' | 'DEBIT' | 'RESERVE' | 'RELEASE';
      return this.mutate(
        compensationId,
        inverse,
        original.accountId,
        original.assetId,
        original.amount,
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
      const previous = await this.operations.lockExisting(client, id);
      if (previous) return previous;
      this.requirePositive(amount);
      await this.accounts.ensureSystemAccount(client);
      await this.balances.applyMutation(client, type, account, asset, amount);
      const result = this.result(id);
      const accountDirection = type === 'CREDIT' || type === 'RELEASE' ? 'CREDIT' : 'DEBIT';
      await this.postings.insertPair(
        client,
        id,
        accountDirection === 'DEBIT' ? account : createId<'AccountId'>('system'),
        accountDirection === 'CREDIT' ? account : createId<'AccountId'>('system'),
        asset,
        amount,
      );
      await this.operations.insert(client, id, type, result, compensationFor);
      if (type === 'RESERVE') {
        await this.reservations.create(client, id, account, asset, amount);
      }
      if (type === 'RELEASE') {
        await this.reservations.release(client, id, account, asset, amount);
      }
      return result;
    });
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
