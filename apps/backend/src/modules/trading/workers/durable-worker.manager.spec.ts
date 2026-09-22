import { DurableWorkerManager } from './durable-worker.manager';
import type {
  DurableWorker,
  DurableWorkerBatchResult,
  DurableWorkerExecution,
  DurableWorkerName,
} from './durable-worker.types';

class TestConfig {
  constructor(private readonly values: Record<string, string | number>) {}
  get<T = string | number>(key: string, fallback: T): T {
    return (this.values[key] ?? fallback) as T;
  }
}

class TestWorker implements DurableWorker {
  readonly name: DurableWorkerName = 'command';
  recoverCount = 0;
  processed = 0;
  lag = 2;
  failures = 0;
  replayed: Array<readonly [string, string]> = [];

  async recover(): Promise<void> {
    await Promise.resolve();
    this.recoverCount += 1;
  }

  async checkReady(): Promise<void> {
    await Promise.resolve();
  }

  async processBatch(execution: DurableWorkerExecution): Promise<DurableWorkerBatchResult> {
    await Promise.resolve();
    if (execution.signal.aborted) throw new Error('ABORTED');
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error('TRANSIENT');
    }
    this.processed += Math.min(execution.policy.batchSize, this.lag);
    this.lag = Math.max(0, this.lag - execution.policy.batchSize);
    return { processed: this.processed, lag: this.lag };
  }

  async replayQuarantined(eventId: string, operatorId: string): Promise<string> {
    await Promise.resolve();
    this.replayed.push([eventId, operatorId] as const);
    return `replay-${eventId}`;
  }
}

describe('DurableWorkerManager', () => {
  it('recovers before readiness and decreases backlog after a committed batch', async () => {
    const worker = new TestWorker();
    const manager = new DurableWorkerManager(
      [worker],
      new TestConfig({ WORKER_BATCH_SIZE: 1 }) as never,
    );

    await manager.recoverAll();
    await expect(manager.checkReady()).resolves.toBeUndefined();
    await manager.tick('command');

    expect(worker.recoverCount).toBe(1);
    expect(manager.getStatuses()).toEqual([
      expect.objectContaining({ name: 'command', state: 'RUNNING', lag: 1, inFlight: 0 }),
    ]);
  });

  it('retries with bounded attempts and marks worker unhealthy after final failure', async () => {
    const worker = new TestWorker();
    worker.failures = 2;
    const manager = new DurableWorkerManager(
      [worker],
      new TestConfig({
        WORKERS_ENABLED: 'false',
        WORKER_MAX_ATTEMPTS: 2,
        WORKER_BASE_BACKOFF_MS: 1,
        WORKER_MAX_BACKOFF_MS: 1,
      }) as never,
    );

    await manager.recoverAll();
    await expect(manager.tick('command')).rejects.toThrow('TRANSIENT');
    expect(manager.getStatuses()[0]).toEqual(
      expect.objectContaining({ state: 'UNHEALTHY', lastErrorCode: 'Error' }),
    );
  });

  it('drains in-flight work and delegates quarantined replay without mutating original event', async () => {
    const worker = new TestWorker();
    const manager = new DurableWorkerManager(
      [worker],
      new TestConfig({ WORKERS_ENABLED: 'false' }) as never,
    );

    await manager.recoverAll();
    await manager.tick('command');
    await manager.stop();
    await expect(manager.replayQuarantined('command', 'evt-1', 'operator-1')).resolves.toBe(
      'replay-evt-1',
    );

    expect(worker.replayed).toEqual([['evt-1', 'operator-1']]);
    expect(manager.getStatuses()[0]).toEqual(
      expect.objectContaining({ state: 'STOPPED', inFlight: 0 }),
    );
  });
});
