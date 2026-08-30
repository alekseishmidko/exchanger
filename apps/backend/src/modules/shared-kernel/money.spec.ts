import { Money } from './money';
import { createId, Decimal } from './index';

describe('Money', () => {
  it('prevents arithmetic across different assets', () => {
    const usd = new Money(createId<'AssetId'>('USD'), Decimal.from('1'));
    const btc = new Money(createId<'AssetId'>('BTC'), Decimal.from('1'));

    expect(() => usd.add(btc)).toThrow('Money asset mismatch');
  });

  it('keeps exact amount and explicit rounding', () => {
    const usd = new Money(createId<'AssetId'>('USD'), Decimal.from('1.005'));

    expect(usd.round(2).amount.toString()).toBe('1.01');
  });
});
