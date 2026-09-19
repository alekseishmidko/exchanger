import { Decimal } from './decimal';
import fc from 'fast-check';

describe('Decimal', () => {
  it('adds exact values without floating point error', () => {
    expect(Decimal.from('0.1').add(Decimal.from('0.2')).toString()).toBe('0.3');
  });

  it('rounds half-up deterministically', () => {
    expect(Decimal.from('1.005').round(2).toString()).toBe('1.01');
    expect(Decimal.from('-1.005').round(2).toString()).toBe('-1.01');
  });

  it('rejects floating point and ambiguous decimal formats', () => {
    expect(() => Decimal.from('1e-2')).toThrow();
    expect(() => Decimal.from('01.2')).toThrow();
    expect(() => Decimal.from('NaN')).toThrow();
    expect(() => Decimal.from('Infinity')).toThrow();
    expect(() => Decimal.from('-Infinity')).toThrow();
  });

  it('covers adversarial decimal boundaries deterministically', () => {
    expect(Decimal.from('0').toString()).toBe('0');
    expect(Decimal.from('0.000000000000000001').toString()).toBe('0.000000000000000001');
    expect(Decimal.from('999999999999999999999999.99999999').toString()).toBe(
      '999999999999999999999999.99999999',
    );
    expect(Decimal.from('1.0049').round(2).toString()).toBe('1');
    expect(Decimal.from('1.0050').round(2).toString()).toBe('1.01');
    expect(Decimal.from('1.9999').round(3).toString()).toBe('2');

    for (const value of ['00', '0001', '00.1', '1e3', '+1', '.1']) {
      expect(() => Decimal.from(value)).toThrow();
    }
  });

  it('preserves commutativity for generated integer decimal values', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        (left, right) => {
          const first = Decimal.from(String(left)).add(Decimal.from(String(right)));
          const second = Decimal.from(String(right)).add(Decimal.from(String(left)));
          expect(first.toString()).toBe(second.toString());
        },
      ),
    );
  });
});
