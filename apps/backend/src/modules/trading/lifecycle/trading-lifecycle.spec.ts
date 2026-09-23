import {
  assertCommandTransition,
  assertOrderTransition,
  COMMAND_TRANSITIONS,
  ORDER_TRANSITIONS,
  TRADING_REJECTION_CODES,
} from './trading-lifecycle';

describe('trading lifecycle contracts', () => {
  it('keeps command transitions monotonic and terminal', () => {
    expect(COMMAND_TRANSITIONS.RECEIVED).toContain('ACCEPTED');
    expect(() => assertCommandTransition('RECEIVED', 'ACCEPTED')).not.toThrow();
    expect(() => assertCommandTransition('APPLIED', 'PROCESSING')).toThrow(
      'Invalid command transition',
    );
    expect(() => assertCommandTransition('REJECTED', 'APPLIED')).toThrow(
      'Invalid command transition',
    );
  });

  it('prevents cancel from resurrecting terminal orders', () => {
    expect(ORDER_TRANSITIONS.OPEN).toContain('CANCEL_PENDING');
    expect(() => assertOrderTransition('OPEN', 'CANCEL_PENDING')).not.toThrow();
    expect(() => assertOrderTransition('FILLED', 'CANCEL_PENDING')).toThrow(
      'Invalid order transition',
    );
    expect(() => assertOrderTransition('CANCELLED', 'OPEN')).toThrow('Invalid order transition');
  });

  it('uses one rejection catalog for public boundaries', () => {
    expect(TRADING_REJECTION_CODES).toEqual(expect.arrayContaining(['COMMAND_ID_REUSED']));
    expect(TRADING_REJECTION_CODES).toEqual(expect.arrayContaining(['IDEMPOTENCY_KEY_REUSED']));
    expect(TRADING_REJECTION_CODES).toEqual(expect.arrayContaining(['ORDER_CANCEL_REJECTED']));
  });
});
