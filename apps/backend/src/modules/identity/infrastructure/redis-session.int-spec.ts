import { ConfigService } from '@nestjs/config';
import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { createClient } from 'redis';
import type { SessionRecord } from '../domain/identity.types';
import { RedisSessionStore } from './redis-session.store';
import { AuthRateLimit } from '../security/auth-rate-limit';

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
    server.kill('SIGTERM');
    await exited(server);
    server = await startRedis(port, directory);
    const restarted = await store();
    expect((await restarted.listByUser('user-1')).map((item) => item.sessionId)).toEqual(
      expect.arrayContaining(['ses-a', 'ses-b']),
    );
  }, 20_000);

  it('never lets a stale touch resurrect a concurrently revoked session', async () => {
    const first = await store();
    const replica = await store();
    const original = session('ses-race');
    await first.create('digest-race', original, 30);
    const stale = await replica.findByTokenDigest('digest-race');
    expect(stale).not.toBeNull();
    await first.revoke('user-1', 'ses-race', new Date().toISOString());
    expect(
      await replica.touch('digest-race', { ...stale!, lastSeenAt: new Date().toISOString() }, 30),
    ).toBe(false);
    expect(await first.findByTokenDigest('digest-race')).toBeNull();
  });

  it('linearizes concurrent login create against revoke-all generation', async () => {
    const first = await store();
    const replica = await store();
    await first.create('digest-before', session('ses-before'), 30);
    await Promise.all([
      first.revokeAll('user-1', new Date().toISOString()),
      replica.create('digest-concurrent', session('ses-concurrent'), 30),
    ]);
    expect(await first.findByTokenDigest('digest-before')).toBeNull();
    const concurrent = await replica.findByTokenDigest('digest-concurrent');
    expect([null, 'ses-concurrent']).toContain(concurrent?.sessionId ?? null);

    await first.create('digest-after', session('ses-after'), 30);
    expect((await replica.findByTokenDigest('digest-after'))?.sessionId).toBe('ses-after');
  });

  it('serializes concurrent max-session trimming across replica clients', async () => {
    const first = await store();
    const replica = await store();
    await Promise.all(
      Array.from({ length: 6 }, async (_value, index) => {
        const selected = index % 2 === 0 ? first : replica;
        await selected.create(`digest-limit-${index}`, session(`ses-limit-${index}`), 30);
        await selected.trimToLimit('user-1', 2, new Date().toISOString());
      }),
    );
    const active = (await first.listByUser('user-1')).filter((item) => !item.revokedAt);
    expect(active).toHaveLength(2);
  });

  it('shares bounded password admission buckets between replicas', async () => {
    const config = new ConfigService({
      RUNTIME_PROFILE: 'production',
      AUTH_REDIS_URL: `redis://127.0.0.1:${port}`,
      AUTH_REDIS_NAMESPACE: `test:${process.pid}:rate`,
      AUTH_RATE_LIMIT: '2',
      AUTH_RATE_GLOBAL_LIMIT: '3',
      AUTH_RATE_WINDOW_MS: '60000',
      AUTH_REDIS_COMMAND_TIMEOUT_MS: '500',
    });
    const first = new AuthRateLimit(config);
    const replica = new AuthRateLimit(config);
    await Promise.all([first.onModuleInit(), replica.onModuleInit()]);
    try {
      await first.check(['ip:a', 'account:a', 'global']);
      await replica.check(['ip:a', 'account:a', 'global']);
      await expect(first.check(['ip:a', 'account:a', 'global'])).rejects.toMatchObject({
        response: { code: 'AUTH_RATE_LIMITED' },
      });
      await expect(replica.check(['ip:b', 'account:b', 'global'])).rejects.toMatchObject({
        response: { code: 'AUTH_RATE_LIMITED' },
      });
    } finally {
      await Promise.all([first.onApplicationShutdown(), replica.onApplicationShutdown()]);
    }
  });

  it('never stores a raw session canary in Redis keys or values', async () => {
    const value = await store();
    const rawCanary = 'session-canary-that-must-never-reach-redis';
    const digest = createHmac('sha256', 'redis-integration-key-secret-long-enough')
      .update(`session\u0000${rawCanary}`)
      .digest('base64url');
    await value.create(digest, session('ses-canary'), 30);
    const inspector = createClient({ url: `redis://127.0.0.1:${port}` });
    await inspector.connect();
    try {
      const keys: string[] = [];
      for await (const batch of inspector.scanIterator({ MATCH: `test:${process.pid}*` }))
        keys.push(...batch);
      const values = keys.length > 0 ? await inspector.mGet(keys) : [];
      expect(JSON.stringify({ keys, values })).not.toContain(rawCanary);
    } finally {
      inspector.destroy();
    }
  });

  it('fails closed within the bounded command deadline during Redis outage', async () => {
    const replica = await store();
    server.kill('SIGKILL');
    await exited(server);
    await expect(replica.check()).rejects.toMatchObject({
      response: { code: 'AUTH_SESSION_STORE_UNAVAILABLE' },
    });
  });

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
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    };
    const timeout = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      fail(new Error('REDIS_START_TIMEOUT'));
    }, 5000);
    timeout.unref();
    child.stdout.on('data', (data: Buffer) => {
      if (!settled && data.toString().includes('Ready to accept connections')) {
        settled = true;
        clearTimeout(timeout);
        resolve(child);
      }
    });
    child.once('error', (error) => fail(error));
    child.once('exit', (code) => {
      if (!settled) fail(new Error(`REDIS_EXIT_${code ?? 'SIGNAL'}`));
    });
  });
}
function exited(child: ChildProcessWithoutNullStreams): Promise<void> {
  return child.exitCode !== null
    ? Promise.resolve()
    : new Promise((resolve) => child.once('exit', () => resolve()));
}
