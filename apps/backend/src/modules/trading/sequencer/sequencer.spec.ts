import { DeterministicClock, TradingStateMachine } from '../state-machine';
import { PartitionOwnershipError, TradingSequencer } from './index';

const clock: DeterministicClock = { now: () => new Date('2026-09-03T00:00:00.000Z') };
type Payload = { readonly value: string };
type Result = { readonly value: string };

function createSequencer(): TradingSequencer<Payload, Result> {
  return new TradingSequencer(
    (instrumentId) => new TradingStateMachine(instrumentId, (payload) => payload, clock),
  );
}

describe('TradingSequencer', () => {
  it('routes commands in order per instrument and independently across instruments', () => {
    const sequencer = createSequencer();
    sequencer.assignOwner('BTC-USD', 'worker-1');
    sequencer.assignOwner('ETH-USD', 'worker-1');

    expect(
      sequencer.submit({
        ownerId: 'worker-1',
        commandId: 'btc-1',
        instrumentId: 'BTC-USD',
        sequence: 1,
        payload: { value: 'btc' },
      }),
    ).toEqual({ value: 'btc' });
    expect(
      sequencer.submit({
        ownerId: 'worker-1',
        commandId: 'eth-1',
        instrumentId: 'ETH-USD',
        sequence: 1,
        payload: { value: 'eth' },
      }),
    ).toEqual({ value: 'eth' });
    expect(() =>
      sequencer.submit({
        ownerId: 'worker-1',
        commandId: 'btc-3',
        instrumentId: 'BTC-USD',
        sequence: 3,
        payload: { value: 'gap' },
      }),
    ).toThrow('SEQUENCE_GAP');
  });

  it('rejects unassigned and non-owner submissions', () => {
    const sequencer = createSequencer();
    expect(() =>
      sequencer.submit({
        ownerId: 'worker-1',
        commandId: 'c1',
        instrumentId: 'BTC-USD',
        sequence: 1,
        payload: { value: 'x' },
      }),
    ).toThrow(new PartitionOwnershipError('PARTITION_UNASSIGNED'));
    sequencer.assignOwner('BTC-USD', 'worker-1');
    expect(() =>
      sequencer.submit({
        ownerId: 'worker-2',
        commandId: 'c1',
        instrumentId: 'BTC-USD',
        sequence: 1,
        payload: { value: 'x' },
      }),
    ).toThrow(new PartitionOwnershipError('NOT_OWNER'));
    expect(() => sequencer.assignOwner('BTC-USD', 'worker-2')).toThrow('NOT_OWNER');
  });

  it('pauses only the selected instrument partition', () => {
    const sequencer = createSequencer();
    sequencer.assignOwner('BTC-USD', 'worker-1');
    sequencer.assignOwner('ETH-USD', 'worker-1');
    sequencer.pause('BTC-USD', 'worker-1');
    expect(() =>
      sequencer.submit({
        ownerId: 'worker-1',
        commandId: 'btc-1',
        instrumentId: 'BTC-USD',
        sequence: 1,
        payload: { value: 'x' },
      }),
    ).toThrow('PAUSED');
    expect(
      sequencer.submit({
        ownerId: 'worker-1',
        commandId: 'eth-1',
        instrumentId: 'ETH-USD',
        sequence: 1,
        payload: { value: 'x' },
      }),
    ).toEqual({ value: 'x' });
  });
});
