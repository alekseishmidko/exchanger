import { AccountId, AssetId, Decimal, OperationId, PostingId } from '../shared-kernel';

/** Направление одной double-entry проводки. */
export type PostingDirection = 'DEBIT' | 'CREDIT';

/** Неизменяемая проводка, являющаяся частью аудируемого журнала. */
export type Posting = Readonly<{
  id: PostingId;
  operationId: OperationId;
  accountId: AccountId;
  assetId: AssetId;
  amount: Decimal;
  direction: PostingDirection;
}>;

/** Проверяет, что набор проводок сбалансирован отдельно по каждому активу. */
export function assertBalancedPostings(postings: readonly Posting[]): void {
  const totals = new Map<string, { debit: Decimal; credit: Decimal }>();
  for (const posting of postings) {
    const total = totals.get(posting.assetId) ?? {
      debit: Decimal.from('0'),
      credit: Decimal.from('0'),
    };
    if (posting.direction === 'DEBIT') {
      total.debit = total.debit.add(posting.amount);
    } else {
      total.credit = total.credit.add(posting.amount);
    }
    totals.set(posting.assetId, total);
  }
  for (const total of totals.values()) {
    if (total.debit.compare(total.credit) !== 0) {
      throw new Error('Posting batch is not balanced');
    }
  }
}
