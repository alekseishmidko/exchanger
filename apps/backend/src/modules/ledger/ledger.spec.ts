import { Account, Asset, Ledger } from './index';
import { createId, Decimal } from '../shared-kernel';

const assetId = createId<'AssetId'>('USD');
const accountA = createId<'AccountId'>('account-a');
const accountB = createId<'AccountId'>('account-b');
const asset = new Asset(assetId, 'USD', 2);

function createLedger(): Ledger {
  const ledger = new Ledger();
  ledger.registerAsset(asset);
  ledger.registerAccount(new Account(accountA, 'user-a'));
  ledger.registerAccount(new Account(accountB, 'user-b'));
  ledger.openBalance(accountA, assetId);
  ledger.openBalance(accountB, assetId);
  return ledger;
}

describe('Ledger', () => {
  it('keeps debit and credit postings balanced', () => {
    const ledger = createLedger();
    ledger.credit(createId<'OperationId'>('credit-1'), accountA, assetId, Decimal.from('100'));

    expect(ledger.getBalance(accountA, assetId).available.toString()).toBe('100');
    expect(ledger.getPostings()).toHaveLength(2);
  });

  it('moves available funds and rejects overdrafts', () => {
    const ledger = createLedger();
    ledger.credit(createId<'OperationId'>('credit-2'), accountA, assetId, Decimal.from('10'));

    ledger.transfer(
      createId<'OperationId'>('transfer-1'),
      accountA,
      accountB,
      assetId,
      Decimal.from('3.25'),
    );

    expect(ledger.getBalance(accountA, assetId).available.toString()).toBe('6.75');
    expect(ledger.getBalance(accountB, assetId).available.toString()).toBe('3.25');
    expect(() =>
      ledger.transfer(
        createId<'OperationId'>('transfer-2'),
        accountA,
        accountB,
        assetId,
        Decimal.from('7'),
      ),
    ).toThrow('Insufficient available balance');
  });

  it('does not apply a duplicate operation twice', () => {
    const ledger = createLedger();
    ledger.credit(createId<'OperationId'>('credit-3'), accountA, assetId, Decimal.from('10'));
    const operationId = createId<'OperationId'>('transfer-duplicate');
    const first = ledger.transfer(operationId, accountA, accountB, assetId, Decimal.from('4'));
    const duplicate = ledger.transfer(operationId, accountA, accountB, assetId, Decimal.from('4'));

    expect(duplicate).toEqual(first);
    expect(ledger.getBalance(accountA, assetId).available.toString()).toBe('6');
    expect(ledger.getPostings()).toHaveLength(4);
  });

  it('enforces reserved not greater than total and supports release', () => {
    const ledger = createLedger();
    ledger.credit(createId<'OperationId'>('credit-4'), accountA, assetId, Decimal.from('10'));
    ledger.reserve(createId<'OperationId'>('reserve-1'), accountA, assetId, Decimal.from('7'));

    expect(ledger.getBalance(accountA, assetId).available.toString()).toBe('3');
    expect(ledger.getBalance(accountA, assetId).reserved.toString()).toBe('7');
    expect(() =>
      ledger.reserve(createId<'OperationId'>('reserve-2'), accountA, assetId, Decimal.from('4')),
    ).toThrow('Insufficient available balance');
    ledger.release(createId<'OperationId'>('release-1'), accountA, assetId, Decimal.from('2'));
    expect(ledger.getBalance(accountA, assetId).available.toString()).toBe('5');
    expect(ledger.getBalance(accountA, assetId).reserved.toString()).toBe('5');
  });

  it('serializes concurrent reservations and never overspends available balance', async () => {
    const ledger = createLedger();
    ledger.credit(
      createId<'OperationId'>('credit-concurrent'),
      accountA,
      assetId,
      Decimal.from('10'),
    );
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, (_, index) =>
        Promise.resolve().then(() =>
          ledger.reserve(
            createId<'OperationId'>(`reserve-concurrent-${index}`),
            accountA,
            assetId,
            Decimal.from('3'),
          ),
        ),
      ),
    );

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(3);
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    expect(ledger.getBalance(accountA, assetId).available.toString()).toBe('1');
    expect(ledger.getBalance(accountA, assetId).reserved.toString()).toBe('9');
  });

  it('compensates with reverse postings without deleting the original', () => {
    const ledger = createLedger();
    ledger.credit(createId<'OperationId'>('credit-5'), accountA, assetId, Decimal.from('10'));
    const originalId = createId<'OperationId'>('transfer-original');
    ledger.transfer(originalId, accountA, accountB, assetId, Decimal.from('4'));
    ledger.compensate(createId<'OperationId'>('transfer-compensation'), originalId);

    expect(ledger.getBalance(accountA, assetId).available.toString()).toBe('10');
    expect(ledger.getBalance(accountB, assetId).available.toString()).toBe('0');
    expect(ledger.getPostings()).toHaveLength(6);
    expect(ledger.getPostings().some(({ operationId }) => operationId === originalId)).toBe(true);
  });

  it('reconciles every operation by asset', () => {
    const ledger = createLedger();
    ledger.credit(
      createId<'OperationId'>('credit-reconcile'),
      accountA,
      assetId,
      Decimal.from('10'),
    );
    ledger.transfer(
      createId<'OperationId'>('transfer-reconcile'),
      accountA,
      accountB,
      assetId,
      Decimal.from('4'),
    );

    expect(() => ledger.reconcile()).not.toThrow();
  });
});
