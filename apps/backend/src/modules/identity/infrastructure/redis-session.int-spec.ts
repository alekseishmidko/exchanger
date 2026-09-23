import { ConfigService } from '@nestjs/config';
import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionRecord } from '../domain/identity.types';
import { RedisSessionStore } from './redis-session.store';

const redisAvailable = process.env['RUN_REDIS_INTEGRATION'] === 'true';

/** Real Redis integration: TTL, replica clients, point/all revoke, restart и outage fail-closed. */
(redisAvailable ? describe : describe.skip)('RedisSessionStore integration', () => {
  const port = 19000 + (process.pid % 1000);
  let directory: string;
  let server: ChildProcessWithoutNullStreams;
  const stores: RedisSessionStore[] = [];

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'exchange-redis-auth-'));
    server = await startRedis(port, directory);
  });
  afterAll(async () => {
    for (const store of stores) await store.onApplicationShutdown().catch(() => undefined);
    if (server && server.exitCode === null && server.signalCode === null) {
      server.kill('SIGTERM');
      await exited(server);
    }
    await rm(directory, { recursive: true, force: true });
  }, 10_000);

  it('shares revoke across replicas, preserves metadata after restart and applies TTL', async () => {
    const first = await store();
    const replica = await store();
    await first.create('digest-a', session('ses-a'), 30);
    await first.create('digest-b', session('ses-b'), 30);
    expect((await replica.findByTokenDigest('digest-a'))?.sessionId).toBe('ses-a');
    expect(await replica.revoke('user-1', 'ses-a', new Date().toISOString())).toBe(true);
    expect(await first.findByTokenDigest('digest-a')).toBeNull();
    expect(await replica.revokeAll('user-1', new Date().toISOString())).toBe(1);
    expect((await first.listByUser('user-1')).every((item) => item.revokedAt)).toBe(true);

    await first.create('digest-short', session('ses-short'), 1);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(await replica.findByTokenDigest('digest-short')).toBeNull();

    await Promise.all(stores.splice(0).map((item) => item.onApplicationShutdown()));
    const restarted = await store();
    expect((await restarted.listByUser('user-1')).map((item) => item.sessionId)).toEqual(
      expect.arrayContaining(['ses-a', 'ses-b']),
    );

    server.kill('SIGKILL');
    await exited(server);
    await expect(restarted.check()).rejects.toMatchObject({
      response: { code: 'AUTH_SESSION_STORE_UNAVAILABLE' },
    });
  }, 20_000);

  async function store(): Promise<RedisSessionStore> {
    const value = new RedisSessionStore(
      new ConfigService({
        AUTH_REDIS_URL: `redis://127.0.0.1:${port}`,
        AUTH_REDIS_NAMESPACE: `test:${process.pid}`,
        AUTH_TOKEN_HASH_SECRET: 'redis-integration-key-secret-long-enough',
      }),
    );
    await value.onModuleInit();
    stores.push(value);
    return value;
  }
});

function session(sessionId: string): SessionRecord {
  const now = new Date();
  return {
    sessionId,
    userId: 'user-1',
    roles: ['USER'],
    scopes: ['profile:read'],
    authLevel: 'PASSWORD',
    createdAt: now.toISOString(),
    lastSeenAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 30_000).toISOString(),
    absoluteExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
    revokedAt: null,
    device: { label: 'test', userAgentDigest: 'ua', ipPrefixDigest: 'ip' },
    correlation: { createdByCorrelationId: 'correlation-1' },
    securityVersion: 1,
  };
}

function startRedis(port: number, directory: string): Promise<ChildProcessWithoutNullStreams> {
  return new Promise((resolve, reject) => {
    const child = spawn('redis-server', [
      '--port',
      String(port),
      '--bind',
      '127.0.0.1',
      '--dir',
      directory,
      '--dbfilename',
      'sessions.rdb',
      '--save',
      '1',
      '1',
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
    child.once('exit', (code) => {
      if (code && code !== 0) reject(new Error(`REDIS_EXIT_${code}`));
    });
  });
}
function exited(child: ChildProcessWithoutNullStreams): Promise<void> {
  return child.exitCode !== null
    ? Promise.resolve()
    : new Promise((resolve) => child.once('exit', () => resolve()));
}
