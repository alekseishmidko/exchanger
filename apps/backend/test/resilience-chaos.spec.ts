import { BadRequestException } from '@nestjs/common';
import { Account, Asset, Ledger } from '../src/modules/ledger';
import { ProjectionEvent, ProjectionStore } from '../src/modules/projections/projection';
import { createId, Decimal } from '../src/modules/shared-kernel';
import { EventLog, EventLogTimeout } from '../src/modules/trading/event-log';
import {
  DeterministicClock,
  StateMachineAdmissionError,
  TradingStateMachine,
} from '../src/modules/trading/state-machine';

/** Создаёт минимальное событие заявки для сценариев gap/rebuild. */
function orderEvent(sequence: number): ProjectionEvent {
  return {
    eventId: `event-${sequence}`,
    eventType: 'OrderAccepted',
    sequence,
    payload: {
      orderId: `order-${sequence}`,
      userId: 'user-1',
      accountId: 'user-1',
      instrumentId: 'BTC-USD',
      remainingQuantity: '1',
    },
  };
}

/**
 * Component chaos suite проверяет бизнес-инварианты без Docker и случайного
 * wall-clock. Каждый fault детерминирован: момент ошибки задаётся счётчиком или
 * sequence, поэтому падение воспроизводится одним и тем же Jest test name.
 */
describe('Resilience chaos invariants', () => {
  it('повторяет append после timeout без потери или дублирования принятого события', async () => {
    const log = new EventLog();
    const event = { eventId: 'event-1', eventType: 'TradeExecuted', payload: { tradeId: 't-1' } };
    log.failNext(1);

    await expect(log.append(event)).rejects.toBeInstanceOf(EventLogTimeout);
    expect(log.getEvents()).toHaveLength(0);
    await log.append(event);

    expect(log.getEvents()).toEqual([expect.objectContaining({ eventId: 'event-1' })]);
  });

  it('сохраняет exactly-once business effect при crash consumer до commit offset', async () => {
    const log = new EventLog();
    const effects = new Set<string>();
    let attempts = 0;
    await log.append({ eventId: 'event-1', eventType: 'SettlementApplied', payload: {} });

    await log.consume(async (event) => {
      await Promise.resolve();
      effects.add(event.eventId);
      attempts += 1;
      if (attempts === 1) throw new Error('deterministic crash before offset commit');
    });

    expect(attempts).toBe(2);
    expect(effects).toEqual(new Set(['event-1']));
    expect(log.getOffset()).toBe(1);
  });

  it('не повторяет committed handler после crash и дедуплицирует повторную доставку в business boundary', async () => {
    const log = new EventLog();
    const effects = new Set<string>();
    let deliveries = 0;
    const event = { eventId: 'event-1', eventType: 'SettlementApplied', payload: {} };
    const handler = async (delivered: Readonly<{ eventId: string }>): Promise<void> => {
      await Promise.resolve();
      deliveries += 1;
      effects.add(delivered.eventId);
    };

    await log.append(event);
    await log.consume(handler);
    await log.consume(handler);
    expect(deliveries).toBe(1);

    await log.append(event);
    await log.consume(handler);
    expect(deliveries).toBe(2);
    expect(effects).toEqual(new Set(['event-1']));
  });

  it('изолирует poison event в DLQ и продолжает уменьшать backlog', async () => {
    const log = new EventLog();
    await log.append({ eventId: 'poison', eventType: 'Unknown', payload: {} });
    await log.append({ eventId: 'healthy', eventType: 'OrderAccepted', payload: {} });
    const consumed: string[] = [];

    await log.consume(async (event) => {
      await Promise.resolve();
      if (event.eventId === 'poison') throw new Error('poison event');
      consumed.push(event.eventId);
    }, 2);

    expect(log.getDeadLetters().map(({ eventId }) => eventId)).toEqual(['poison']);
    expect(consumed).toEqual(['healthy']);
    expect(log.getOffset()).toBe(2);
  });

  it('восстанавливает monotonic sequence и duplicate result после crash/restart', () => {
    const clock: DeterministicClock = { now: () => new Date('2026-03-29T01:30:00+01:00') };
    const createMachine = () =>
      new TradingStateMachine<string, Readonly<{ accepted: string }>>(
        'BTC-USD',
        (payload) => ({ accepted: payload }),
        clock,
      );
    const original = createMachine();
    const first = {
      commandId: 'command-1',
      instrumentId: 'BTC-USD',
      sequence: 1,
      payload: 'first',
    };
    const firstResult = original.apply(first);
    const snapshot = original.createSnapshot();
    const recovered = createMachine();
    recovered.restoreSnapshot(snapshot);

    expect(recovered.apply(first)).toEqual(firstResult);
    expect(() => recovered.apply({ ...first, commandId: 'command-3', sequence: 3 })).toThrow(
      new StateMachineAdmissionError('SEQUENCE_GAP'),
    );
    expect(
      recovered.apply({ ...first, commandId: 'command-2', sequence: 2, payload: 'second' }),
    ).toEqual({ accepted: 'second' });
    expect(recovered.getState().sequence).toBe(2);
    expect(snapshot.capturedAt).toBe('2026-03-29T00:30:00.000Z');
  });

  it('блокирует admission при pause и продолжает с ожидаемого sequence после resume', () => {
    const machine = new TradingStateMachine('BTC-USD', (payload: string) => payload, {
      now: () => new Date('2026-12-31T23:59:59.999Z'),
    });
    machine.pause();

    expect(() =>
      machine.apply({ commandId: 'command-1', instrumentId: 'BTC-USD', sequence: 1, payload: 'x' }),
    ).toThrow(new StateMachineAdmissionError('PAUSED'));
    machine.resume();
    expect(
      machine.apply({ commandId: 'command-1', instrumentId: 'BTC-USD', sequence: 1, payload: 'x' }),
    ).toBe('x');
  });

  it('обнаруживает projection gap, затем сходится после упорядоченного replay', () => {
    const projection = new ProjectionStore();
    expect(() => projection.apply(orderEvent(2))).toThrow(BadRequestException);
    expect(projection.getMetrics().appliedSequence).toBe(0);

    projection.apply(orderEvent(1));
    projection.observeSourceSequence(2);
    expect(projection.getMetrics().lag).toBe(1);
    projection.apply(orderEvent(2));
    projection.apply(orderEvent(2));

    expect(projection.getMetrics()).toEqual({
      schemaVersion: 1,
      appliedSequence: 2,
      sourceSequence: 2,
      lag: 0,
    });
    expect(projection.getOrders('user-1').items).toHaveLength(2);
  });

  it('не создаёт вторую reservation и сохраняет balanced immutable postings', () => {
    const ledger = new Ledger();
    const assetId = createId<'AssetId'>('USD');
    const accountId = createId<'AccountId'>('account-1');
    ledger.registerAsset(new Asset(assetId, 'USD', 2));
    ledger.registerAccount(new Account(accountId, 'user-1'));
    ledger.openBalance(accountId, assetId);
    ledger.credit(createId<'OperationId'>('fund'), accountId, assetId, Decimal.from('100'));
    const reservationId = createId<'OperationId'>('reserve-1');
    const first = ledger.reserve(reservationId, accountId, assetId, Decimal.from('25'));
    const postingCount = ledger.getPostings().length;

    expect(ledger.reserve(reservationId, accountId, assetId, Decimal.from('25'))).toEqual(first);
    expect(ledger.getPostings()).toHaveLength(postingCount);
    expect(ledger.getBalance(accountId, assetId).available.toString()).toBe('75');
    expect(ledger.getBalance(accountId, assetId).reserved.toString()).toBe('25');
    expect(() => ledger.reconcile()).not.toThrow();
  });
});
