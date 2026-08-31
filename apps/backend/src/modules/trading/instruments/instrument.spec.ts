import { Decimal, createId } from '../../shared-kernel';
import { Instrument, InstrumentRules } from './instrument';
import { TradingRuleViolation, validateOrder } from './instrument.validator';

const baseAsset = createId<'AssetId'>('BTC');
const quoteAsset = createId<'AssetId'>('USD');
const at = new Date('2026-01-01T00:00:00.000Z');

function rules(version = 'v1', effectiveAt = at): InstrumentRules {
  return {
    version,
    effectiveAt,
    tickSize: Decimal.from('0.50'),
    lotSize: Decimal.from('0.001'),
    minQuantity: Decimal.from('0.001'),
    maxQuantity: Decimal.from('10'),
    priceBand: { min: Decimal.from('100'), max: Decimal.from('100000') },
    feePolicyVersion: `fees-${version}`,
    limits: {
      maxOrderQuantity: Decimal.from('10'),
      maxOpenOrders: 100,
      maxNotional: Decimal.from('1000000'),
    },
  };
}

function activeInstrument(): Instrument {
  const instrument = new Instrument('BTC-USD', baseAsset, quoteAsset, rules());
  instrument.activate();
  return instrument;
}

describe('Instrument catalog and trading rules', () => {
  it('validates precision, limits and returns immutable rule version', () => {
    const result = validateOrder(
      activeInstrument(),
      {
        orderType: 'LIMIT',
        quantity: Decimal.from('0.005'),
        limitPrice: Decimal.from('50000.50'),
        openOrders: 0,
      },
      at,
    );

    expect(result).toEqual({ valid: true, rulesVersion: 'v1', feePolicyVersion: 'fees-v1' });
  });

  it('rejects invalid tick, lot, quantity and price band values', () => {
    expect(
      () =>
        new Instrument('BTC-USD', baseAsset, quoteAsset, {
          ...rules(),
          tickSize: Decimal.from('0'),
        }),
    ).toThrow('Invalid instrument rules');
    const instrument = activeInstrument();
    expect(() =>
      validateOrder(
        instrument,
        {
          orderType: 'LIMIT',
          quantity: Decimal.from('0.0005'),
          limitPrice: Decimal.from('50000'),
          openOrders: 0,
        },
        at,
      ),
    ).toThrow('INVALID_QUANTITY');
    expect(() =>
      validateOrder(
        instrument,
        {
          orderType: 'LIMIT',
          quantity: Decimal.from('0.001'),
          limitPrice: Decimal.from('50000.25'),
          openOrders: 0,
        },
        at,
      ),
    ).toThrow('INVALID_PRICE');
  });

  it('enforces active/paused lifecycle', () => {
    const instrument = new Instrument('BTC-USD', baseAsset, quoteAsset, rules());
    expect(() =>
      validateOrder(
        instrument,
        {
          orderType: 'LIMIT',
          quantity: Decimal.from('1'),
          limitPrice: Decimal.from('50000'),
          openOrders: 0,
        },
        at,
      ),
    ).toThrow(new TradingRuleViolation('INSTRUMENT_PAUSED'));
    instrument.activate();
    instrument.pause();
    expect(() =>
      validateOrder(
        instrument,
        {
          orderType: 'LIMIT',
          quantity: Decimal.from('1'),
          limitPrice: Decimal.from('50000'),
          openOrders: 0,
        },
        at,
      ),
    ).toThrow('INSTRUMENT_PAUSED');
  });

  it('selects the rule version effective at order time', () => {
    const instrument = activeInstrument();
    instrument.addRules(rules('v2', new Date('2026-02-01T00:00:00.000Z')));
    expect(
      validateOrder(
        instrument,
        {
          orderType: 'LIMIT',
          quantity: Decimal.from('1'),
          limitPrice: Decimal.from('50000'),
          openOrders: 0,
        },
        new Date('2026-01-15T00:00:00.000Z'),
      ).rulesVersion,
    ).toBe('v1');
    expect(
      validateOrder(
        instrument,
        {
          orderType: 'LIMIT',
          quantity: Decimal.from('1'),
          limitPrice: Decimal.from('50000'),
          openOrders: 0,
        },
        new Date('2026-02-02T00:00:00.000Z'),
      ).rulesVersion,
    ).toBe('v2');
  });

  it('rejects invalid version ordering and notional limit', () => {
    const instrument = activeInstrument();
    expect(() => instrument.addRules(rules('old', at))).toThrow('effectiveAt');
    const limited = new Instrument('BTC-USD', baseAsset, quoteAsset, {
      ...rules(),
      limits: { ...rules().limits, maxNotional: Decimal.from('1000') },
    });
    limited.activate();
    expect(() =>
      validateOrder(
        limited,
        {
          orderType: 'LIMIT',
          quantity: Decimal.from('1'),
          limitPrice: Decimal.from('50000'),
          openOrders: 0,
        },
        at,
      ),
    ).toThrow('NOTIONAL_LIMIT');
  });
});
