import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RedisQuoteStore } from './redis-quote.store';
import { RedisIngestLease } from './redis-ingest-lease';

const redisAvailable = process.env['RUN_REDIS_INTEGRATION'] === 'true';
if (!redisAvailable)
  throw new Error('RUN_REDIS_INTEGRATION=true is required for Redis integration tests');

describe('RedisQuoteStore integration', () => {
  const port = 20000 + (process.pid % 1000);
  let directory: string;
  let server: ChildProcessWithoutNullStreams;
  let store: RedisQuoteStore;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'exchange-realtime-redis-'));
    server = await startRedis(port, directory);
    store = new RedisQuoteStore(`redis://127.0.0.1:${port}`, 1000);
    await store.connect();
  });

  afterAll(async () => {
    await store?.close().catch(() => undefined);
    if (server?.exitCode === null) {
      server.kill('SIGTERM');
      await new Promise<void>((resolve) => server.once('exit', () => resolve()));
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('atomically assigns sequence, rejects older/duplicate ticks and expires latest', async () => {
    const base = {
      instrumentId: 'td:forex:aggregate:EUR-USD',
      quoteId: 'q:first',
      price: '1.1',
      priceType: 'LAST' as const,
      providerTimestamp: '2026-09-28T00:00:00.000Z',
      receivedAt: '2026-09-28T00:00:00.100Z',
      expiresAt: '2026-09-28T00:00:05.100Z',
      status: 'FRESH' as const,
      source: 'TwelveData' as const,
    };
    expect((await store.putLatest(base))?.sequence).toBe('1');
    await expect(store.putLatest({ ...base, quoteId: 'q:duplicate' })).resolves.toBeNull();
    await expect(
      store.putLatest({
        ...base,
        quoteId: 'q:older',
        providerTimestamp: '2026-09-27T23:59:59.000Z',
      }),
    ).resolves.toBeNull();
    expect(
      (
        await store.putLatest({
          ...base,
          quoteId: 'q:second',
          price: '1.2',
          providerTimestamp: '2026-09-28T00:00:01.000Z',
        })
      )?.sequence,
    ).toBe('2');
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await expect(store.getLatest(base.instrumentId)).resolves.toBeNull();
  });

  it('fences stale ingest owners and distributes private execution events', async () => {
    const lease = new RedisIngestLease(`redis://127.0.0.1:${port}`, 5000);
    await lease.connect();
    await expect(lease.acquire()).resolves.toBe(true);
    const quote = {
      instrumentId: 'td:forex:aggregate:GBP-USD',
      quoteId: 'q:fenced',
      price: '1.3',
      priceType: 'LAST' as const,
      providerTimestamp: '2026-09-28T00:00:02.000Z',
      receivedAt: '2026-09-28T00:00:02.100Z',
      expiresAt: '2026-09-28T00:00:07.100Z',
      status: 'FRESH' as const,
      source: 'TwelveData' as const,
    };
    await expect(store.putLatest(quote, 'stale-owner')).resolves.toBeNull();
    await expect(store.putLatest(quote, lease.fenceToken())).resolves.toMatchObject({
      sequence: '1',
    });

    let receive!: (value: string) => void;
    const received = new Promise<string>((resolve) => {
      receive = resolve;
    });
    const unsubscribe = await store.subscribeExecutions((ownerId, execution) =>
      receive(`${ownerId}:${execution.orderId}`),
    );
    await store.publishExecution('user-1', {
      commandId: 'command-1',
      orderId: 'order-1',
      executionId: 'execution-1',
      accountId: 'account-1',
      instrumentId: quote.instrumentId,
      side: 'BUY',
      quantity: '1',
      price: '1.3',
      notional: '1.3',
      fee: '0',
      quoteId: quote.quoteId,
      priceSource: 'TwelveData',
      priceType: 'LAST',
      providerTimestamp: quote.providerTimestamp,
      receivedAt: quote.receivedAt,
      status: 'FILLED',
      createdAt: quote.receivedAt,
    });
    await expect(received).resolves.toBe('user-1:order-1');
    await unsubscribe();
    await lease.close();
  });
});

function startRedis(port: number, directory: string): Promise<ChildProcessWithoutNullStreams> {
  return new Promise((resolve, reject) => {
    const child = spawn('redis-server', [
      '--port',
      String(port),
      '--bind',
      '127.0.0.1',
      '--dir',
      directory,
      '--save',
      '',
      '--appendonly',
      'no',
    ]);
    const timeout = setTimeout(() => reject(new Error('REDIS_START_TIMEOUT')), 5000);
    child.stdout.on('data', (data: Buffer) => {
      if (data.toString().includes('Ready to accept connections')) {
        clearTimeout(timeout);
        resolve(child);
      }
    });
    child.once('error', reject);
  });
}
