import { EventLog } from '../src/modules/trading/event-log';

/**
 * Практическая component-level проверка recovery objectives event log.
 *
 * RPO считается нулевым, если после archive/restore совпадают все принятые event
 * IDs. RTO измеряет wall-clock восстановление 10 000 событий; порог в 1 секунду
 * является Pilot regression budget для in-memory adapter, а не production SLA.
 */
describe('System recovery objectives', () => {
  it('restores accepted event log with RPO=0 inside Pilot RTO', async () => {
    const log = new EventLog();
    for (let index = 0; index < 10_000; index += 1) {
      await log.append({ eventId: `event-${index}`, eventType: 'PilotEvent', payload: { index } });
    }
    const archive = log.createArchive(new Date('2026-09-08T00:00:00Z'));
    const startedAt = performance.now();
    const restored = EventLog.restore(archive);
    const recoveryTimeMs = performance.now() - startedAt;
    expect(restored.getEvents().map(({ eventId }) => eventId)).toEqual(
      log.getEvents().map(({ eventId }) => eventId),
    );
    expect(recoveryTimeMs).toBeLessThan(1000);
  });
});
