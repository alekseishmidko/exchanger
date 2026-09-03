import { EventLog, EventLogTimeout } from './index';

describe('EventLog', () => {
  it('retries transient append timeout', async () => {
    const log = new EventLog();
    log.failNext(1);
    await expect(
      log.append({ eventId: 'e1', eventType: 'TradeExecuted', payload: {} }),
    ).rejects.toBeInstanceOf(EventLogTimeout);
    await expect(
      log.append({ eventId: 'e1', eventType: 'TradeExecuted', payload: {} }),
    ).resolves.toBeUndefined();
  });

  it('commits offset after handler success and safely reprocesses crash before commit', async () => {
    const log = new EventLog();
    await log.append({ eventId: 'e1', eventType: 'TradeExecuted', payload: { value: 1 } });
    let attempts = 0;
    await log.consume(async () => {
      await Promise.resolve();
      attempts += 1;
      if (attempts === 1) throw new Error('consumer crash');
    });

    expect(attempts).toBe(2);
    expect(log.getOffset()).toBe(1);
  });

  it('moves poison event to dead letter after retry policy', async () => {
    const log = new EventLog();
    await log.append({ eventId: 'bad', eventType: 'TradeExecuted', payload: {} });
    await log.consume(async () => {
      await Promise.resolve();
      throw new Error('permanent failure');
    }, 2);

    expect(log.getDeadLetters()).toEqual([expect.objectContaining({ eventId: 'bad' })]);
    expect(log.getOffset()).toBe(1);
  });
});
