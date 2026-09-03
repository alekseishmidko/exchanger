import { AccountId, AssetId, createId, Decimal, OperationId, PostingId } from '../shared-kernel';
import { Account, Asset } from './asset-account';
import { Balance } from './balance';
import { assertBalancedPostings, Posting } from './posting';

/** Результат идемпотентной операции ledger. */
export type OperationResult = Readonly<{
  operationId: OperationId;
  postingIds: readonly PostingId[];
}>;

/** Неизменяемая запись, связывающая operationId с уже применённым результатом. */
export type IdempotencyRecord = Readonly<OperationResult>;

/** In-memory aggregate ledger для детерминированных доменных тестов. */
export class Ledger {
  private readonly balances = new Map<string, Balance>();
  private readonly postings: Posting[] = [];
  private readonly operations = new Map<OperationId, OperationResult>();
  private nextPostingNumber = 1;

  /** Регистрирует asset definition до проведения операций. */
  registerAsset(asset: Asset): void {
    if (this.assets.has(asset.id)) {
      throw new Error('Asset already exists');
    }
    this.assets.set(asset.id, asset);
  }

  /** Регистрирует счёт до его использования. */
  registerAccount(account: Account): void {
    if (this.accounts.has(account.id)) {
      throw new Error('Account already exists');
    }
    this.accounts.set(account.id, account);
  }

  /** Создаёт нулевой баланс счёта по активу. */
  openBalance(accountId: AccountId, assetId: AssetId): void {
    this.requireAccount(accountId);
    this.requireAsset(assetId);
    const key = this.key(accountId, assetId);
    if (this.balances.has(key)) {
      throw new Error('Balance already exists');
    }
    this.balances.set(key, Balance.empty());
  }

  /** Возвращает неизменяемый snapshot баланса. */
  getBalance(accountId: AccountId, assetId: AssetId): Balance {
    const balance = this.balances.get(this.key(accountId, assetId));
    if (!balance) {
      throw new Error('Balance does not exist');
    }
    return balance;
  }

  /** Зачисляет средства на счёт и создаёт сбалансированную credit-проводку. */
  credit(
    operationId: OperationId,
    accountId: AccountId,
    assetId: AssetId,
    amount: Decimal,
  ): OperationResult {
    const previous = this.operations.get(operationId);
    if (previous) return previous;
    const balance = this.getBalance(accountId, assetId).credit(amount);
    this.balances.set(this.key(accountId, assetId), balance);
    return this.recordBalancedMarker(operationId, accountId, assetId, amount, 'CREDIT');
  }

  /** Списывает средства со счёта и создаёт сбалансированную debit-проводку. */
  debit(
    operationId: OperationId,
    accountId: AccountId,
    assetId: AssetId,
    amount: Decimal,
  ): OperationResult {
    const previous = this.operations.get(operationId);
    if (previous) return previous;
    const balance = this.getBalance(accountId, assetId).debit(amount);
    this.balances.set(this.key(accountId, assetId), balance);
    return this.recordBalancedMarker(operationId, accountId, assetId, amount, 'DEBIT');
  }

  /** Переводит available между счетами и не повторяет operationId. */
  transfer(
    operationId: OperationId,
    debitAccountId: AccountId,
    creditAccountId: AccountId,
    assetId: AssetId,
    amount: Decimal,
  ): OperationResult {
    const previous = this.operations.get(operationId);
    if (previous) return previous;
    if (amount.isNegative() || amount.isZero()) throw new Error('Amount must be positive');
    const debit = this.getBalance(debitAccountId, assetId).debit(amount);
    const credit = this.getBalance(creditAccountId, assetId).credit(amount);
    const debitPosting = this.createPosting(operationId, debitAccountId, assetId, amount, 'DEBIT');
    const creditPosting = this.createPosting(
      operationId,
      creditAccountId,
      assetId,
      amount,
      'CREDIT',
    );
    assertBalancedPostings([debitPosting, creditPosting]);
    this.balances.set(this.key(debitAccountId, assetId), debit);
    this.balances.set(this.key(creditAccountId, assetId), credit);
    this.postings.push(debitPosting, creditPosting);
    const result = { operationId, postingIds: [debitPosting.id, creditPosting.id] } as const;
    this.operations.set(operationId, result);
    return result;
  }

  /** Переводит средства из reserved источника в available получателя. */
  settleReservedTransfer(
    operationId: OperationId,
    debitAccountId: AccountId,
    creditAccountId: AccountId,
    assetId: AssetId,
    amount: Decimal,
  ): OperationResult {
    const previous = this.operations.get(operationId);
    if (previous) return previous;
    if (amount.isNegative() || amount.isZero()) throw new Error('Amount must be positive');
    const debit = this.getBalance(debitAccountId, assetId).debitReserved(amount);
    const credit = this.getBalance(creditAccountId, assetId).credit(amount);
    const debitPosting = this.createPosting(operationId, debitAccountId, assetId, amount, 'DEBIT');
    const creditPosting = this.createPosting(
      operationId,
      creditAccountId,
      assetId,
      amount,
      'CREDIT',
    );
    assertBalancedPostings([debitPosting, creditPosting]);
    this.balances.set(this.key(debitAccountId, assetId), debit);
    this.balances.set(this.key(creditAccountId, assetId), credit);
    this.postings.push(debitPosting, creditPosting);
    const result = { operationId, postingIds: [debitPosting.id, creditPosting.id] } as const;
    this.operations.set(operationId, result);
    return result;
  }

  /** Резервирует available, повтор operationId возвращает прежний результат. */
  reserve(
    operationId: OperationId,
    accountId: AccountId,
    assetId: AssetId,
    amount: Decimal,
  ): OperationResult {
    const previous = this.operations.get(operationId);
    if (previous) return previous;
    const balance = this.getBalance(accountId, assetId).reserve(amount);
    this.balances.set(this.key(accountId, assetId), balance);
    return this.recordBalancedMarker(operationId, accountId, assetId, amount, 'DEBIT');
  }

  /** Освобождает reserved без удаления исходной reservation записи. */
  release(
    operationId: OperationId,
    accountId: AccountId,
    assetId: AssetId,
    amount: Decimal,
  ): OperationResult {
    const previous = this.operations.get(operationId);
    if (previous) return previous;
    const balance = this.getBalance(accountId, assetId).release(amount);
    this.balances.set(this.key(accountId, assetId), balance);
    return this.recordBalancedMarker(operationId, accountId, assetId, amount, 'CREDIT');
  }

  /** Создаёт обратные проводки, сохраняя исходную операцию в append-only журнале. */
  compensate(compensationId: OperationId, originalOperationId: OperationId): OperationResult {
    const previous = this.operations.get(compensationId);
    if (previous) return previous;
    const original = this.postings.filter((posting) => posting.operationId === originalOperationId);
    if (original.length === 0) throw new Error('Original operation does not exist');
    const changes = original.map((posting) => ({
      posting,
      balance:
        posting.direction === 'DEBIT'
          ? this.getBalance(posting.accountId, posting.assetId).credit(posting.amount)
          : this.getBalance(posting.accountId, posting.assetId).debit(posting.amount),
    }));
    const reversed = original.map((posting) =>
      this.createPosting(
        compensationId,
        posting.accountId,
        posting.assetId,
        posting.amount,
        posting.direction === 'DEBIT' ? 'CREDIT' : 'DEBIT',
      ),
    );
    assertBalancedPostings(reversed);
    for (const change of changes) {
      this.balances.set(this.key(change.posting.accountId, change.posting.assetId), change.balance);
    }
    this.postings.push(...reversed);
    const result = { operationId: compensationId, postingIds: reversed.map(({ id }) => id) };
    this.operations.set(compensationId, result);
    return result;
  }

  /** Возвращает append-only журнал проводок для reconciliation и audit. */
  getPostings(): readonly Posting[] {
    return [...this.postings];
  }

  /** Проверяет, что каждая операция журнала остаётся сбалансированной по asset. */
  reconcile(): void {
    const byOperation = new Map<OperationId, Posting[]>();
    for (const posting of this.postings) {
      const operationPostings = byOperation.get(posting.operationId) ?? [];
      operationPostings.push(posting);
      byOperation.set(posting.operationId, operationPostings);
    }
    for (const operationPostings of byOperation.values()) {
      assertBalancedPostings(operationPostings);
    }
  }

  private readonly assets = new Map<AssetId, Asset>();
  private readonly accounts = new Map<AccountId, Account>();
  private readonly systemAccount = createId<'AccountId'>('system');

  private recordBalancedMarker(
    operationId: OperationId,
    accountId: AccountId,
    assetId: AssetId,
    amount: Decimal,
    direction: 'DEBIT' | 'CREDIT',
  ): OperationResult {
    const accountPosting = this.createPosting(operationId, accountId, assetId, amount, direction);
    const systemPosting = this.createPosting(
      operationId,
      this.systemAccount,
      assetId,
      amount,
      direction === 'DEBIT' ? 'CREDIT' : 'DEBIT',
    );
    assertBalancedPostings([accountPosting, systemPosting]);
    this.postings.push(accountPosting, systemPosting);
    const result = {
      operationId,
      postingIds: [accountPosting.id, systemPosting.id],
    } as const;
    this.operations.set(operationId, result);
    return result;
  }

  private createPosting(
    operationId: OperationId,
    accountId: AccountId,
    assetId: AssetId,
    amount: Decimal,
    direction: 'DEBIT' | 'CREDIT',
  ): Posting {
    return {
      id: createId<'PostingId'>(`posting-${this.nextPostingNumber++}`),
      operationId,
      accountId,
      assetId,
      amount,
      direction,
    };
  }

  private requireAccount(accountId: AccountId): void {
    if (!this.accounts.has(accountId)) throw new Error('Account does not exist');
  }

  private requireAsset(assetId: AssetId): void {
    if (!this.assets.has(assetId)) throw new Error('Asset does not exist');
  }

  private key(accountId: AccountId, assetId: AssetId): string {
    return `${accountId}:${assetId}`;
  }
}
