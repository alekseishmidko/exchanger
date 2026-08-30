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
