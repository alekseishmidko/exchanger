import { randomUUID } from 'node:crypto';
import { createClient, type RedisClientType } from 'redis';

const RENEW = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end`;
const RELEASE = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;

/** Fenced single-owner lease не позволяет replicas открывать лишние upstream sockets. */
export class RedisIngestLease {
  private readonly client: RedisClientType;
  private readonly token = randomUUID();
  private readonly key = 'realtime:ingest-leader:v1';

  constructor(
    url: string,
    private readonly ttlMs: number,
  ) {
    this.client = createClient({
      url,
      disableOfflineQueue: true,
      socket: { reconnectStrategy: false },
    });
    this.client.on('error', () => undefined);
  }

  async connect(): Promise<void> {
    if (!this.client.isOpen) await this.client.connect();
  }
  fenceToken(): string {
    return this.token;
  }
  async acquire(): Promise<boolean> {
    return (await this.client.set(this.key, this.token, { NX: true, PX: this.ttlMs })) === 'OK';
  }
  async renew(): Promise<boolean> {
    return (
      Number(
        await this.client.eval(RENEW, {
          keys: [this.key],
          arguments: [this.token, String(this.ttlMs)],
        }),
      ) === 1
    );
  }
  async close(): Promise<void> {
    if (!this.client.isOpen) return;
    await this.client
      .eval(RELEASE, { keys: [this.key], arguments: [this.token] })
      .catch(() => undefined);
    await this.client.quit();
  }
}
