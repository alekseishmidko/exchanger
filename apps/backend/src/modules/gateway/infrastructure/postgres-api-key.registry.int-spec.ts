import { Pool } from 'pg';
import { PostgresApiKeyRegistry } from './postgres-api-key.registry';

const postgresUrl = process.env['POSTGRES_URL'];
const describePostgres = postgresUrl ? describe : describe.skip;

/** Проверяет live machine credentials через две реплики на настоящем PostgreSQL. */
describePostgres('PostgresApiKeyRegistry integration', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: postgresUrl, max: 4 });
    await pool.query('DROP TABLE IF EXISTS machine_api_keys');
    await pool.query(`
      CREATE TABLE machine_api_keys (
        key_id TEXT PRIMARY KEY,
        secret_digest TEXT NOT NULL UNIQUE,
        owner_id TEXT NOT NULL,
        owner_type TEXT NOT NULL CHECK (owner_type IN ('USER','SERVICE','SYSTEM')),
        role TEXT NOT NULL CHECK (role IN ('trader','admin','risk_manager','auditor','support')),
        label TEXT NOT NULL,
        scopes TEXT[] NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVOKED')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        rotated_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ,
        last_used_at TIMESTAMPTZ
      )
    `);
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  it('propagates issue, rotate and revoke immediately between replicas and restart', async () => {
    const first = new PostgresApiKeyRegistry(pool);
    const second = new PostgresApiKeyRegistry(pool);
    await Promise.all([first.onModuleInit(), second.onModuleInit()]);
    const issued = await first.issue({
      userId: 'integration-service',
      ownerType: 'SERVICE',
      role: 'trader',
      label: 'two-replica-test',
      scopes: ['trading:read'],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    expect((await second.authenticate(issued.apiKey)).keyId).toBe(issued.metadata.keyId);

    const rotated = await second.rotate(issued.metadata.keyId);
    await expect(first.authenticate(issued.apiKey)).rejects.toMatchObject({
      response: { code: 'AUTH_INVALID_API_KEY' },
    });
    const restarted = new PostgresApiKeyRegistry(pool);
    await restarted.onModuleInit();
    expect((await restarted.authenticate(rotated.apiKey)).keyId).toBe(issued.metadata.keyId);

    await first.revoke(issued.metadata.keyId);
    await expect(second.authenticate(rotated.apiKey)).rejects.toMatchObject({
      response: { code: 'AUTH_INVALID_API_KEY' },
    });
    expect(JSON.stringify(await pool.query('SELECT * FROM machine_api_keys'))).not.toContain(
      issued.apiKey,
    );
    expect(JSON.stringify(await pool.query('SELECT * FROM machine_api_keys'))).not.toContain(
      rotated.apiKey,
    );
  });
});
