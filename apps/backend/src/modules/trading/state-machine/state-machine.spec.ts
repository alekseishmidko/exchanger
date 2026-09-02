import { DeterministicClock, StateMachineAdmissionError, TradingStateMachine } from './index';

const clock: DeterministicClock = { now: () => new Date('2026-09-03T00:00:00.000Z') };

function machine(instrumentId = 'BTC-USD'): TradingStateMachine<string, { value: string }> {
  return new TradingStateMachine(instrumentId, (payload) => ({ value: payload }), clock);
}

describe('TradingStateMachine', () => {
  it('accepts monotonic commands, deduplicates and detects sequence gaps', () => {
    const state = machine();
    const command = { commandId: 'c1', instrumentId: 'BTC-USD', sequence: 1, payload: 'one' };
    const first = state.apply(command);

    expect(state.apply(command)).toBe(first);
    expect(() => state.apply({ ...command, commandId: 'c3', sequence: 3 })).toThrow(
      new StateMachineAdmissionError('SEQUENCE_GAP'),
    );
  });

  it('restores sequence, status and duplicate results after restart', () => {
    const original = machine();
    const command = { commandId: 'c1', instrumentId: 'BTC-USD', sequence: 1, payload: 'one' };
    const result = original.apply(command);
    original.pause();
    const snapshot = original.createSnapshot();
    const restarted = machine();
    restarted.restoreSnapshot(snapshot);

    expect(restarted.getState()).toEqual({ sequence: 1, status: 'PAUSED' });
    expect(restarted.apply(command)).toBe(result);
    restarted.resume();
    expect(
      restarted.apply({ commandId: 'c2', instrumentId: 'BTC-USD', sequence: 2, payload: 'two' }),
    ).toEqual({ value: 'two' });
  });

  it('blocks commands while paused and rejects invalid instrument sequence', () => {
    const state = machine();
    state.pause();
    expect(() =>
      state.apply({ commandId: 'c1', instrumentId: 'BTC-USD', sequence: 1, payload: 'one' }),
    ).toThrow('PAUSED');
    state.resume();
    expect(() =>
      state.apply({ commandId: 'c1', instrumentId: 'ETH-USD', sequence: 1, payload: 'one' }),
    ).toThrow('INVALID_SEQUENCE');
  });
});
