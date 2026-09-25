import type { Pool } from 'pg';
import { PostgresApiKeyRegistry } from './postgres-api-key.registry';

/** Canary test: durable machine credential SQL receives digest/metadata, never raw API key. */
describe('PostgresApiKeyRegistry', () => {
  it('persists issue/rotate/revoke without plaintext secret', async () => {
    let row: Record<string, unknown> | undefined;
    const query = jest.fn((sql: string, values: unknown[] = []) => {
      if (sql.startsWith('SELECT * FROM machine_api_keys'))
        return Promise.resolve({ rows: row ? [row] : [], rowCount: row ? 1 : 0 });
      if (sql.includes('INSERT INTO machine_api_keys')) {
        row = {
          key_id: values[0],
          secret_digest: values[1],
          owner_id: values[2],
          owner_type: values[3],
          role: values[4],
          label: values[5],
          scopes: values[6],
          expires_at: new Date(String(values[7])),
          status: 'ACTIVE',
          created_at: new Date(String(values[8])),
          rotated_at: null,
          revoked_at: null,
          last_used_at: null,
        };
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (sql.includes('SET last_used_at=clock_timestamp()'))
        return Promise.resolve(
          row && row.secret_digest === values[0] && row.status === 'ACTIVE'
            ? { rows: [row], rowCount: 1 }
            : { rows: [], rowCount: 0 },
        );
      if (sql.includes('SET secret_digest=$2')) {
        if (!row || row.status !== 'ACTIVE') return Promise.resolve({ rows: [], rowCount: 0 });
        row = {
          ...row,
          secret_digest: values[1],
          expires_at: new Date(String(values[2])),
          rotated_at: new Date(String(values[3])),
          last_used_at: null,
        };
        return Promise.resolve({ rows: [row], rowCount: 1 });
      }
      if (sql.includes("SET status='REVOKED'")) {
        if (!row) return Promise.resolve({ rows: [], rowCount: 0 });
        row = { ...row, status: 'REVOKED', revoked_at: new Date(String(values[1])) };
        return Promise.resolve({ rows: [row], rowCount: 1 });
      }
      if (sql.startsWith('SELECT status'))
        return Promise.resolve({
          rows: row ? [{ status: row.status }] : [],
          rowCount: row ? 1 : 0,
        });
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    const registry = new PostgresApiKeyRegistry({ query } as unknown as Pool);
    const replica = new PostgresApiKeyRegistry({ query } as unknown as Pool);
    await registry.onModuleInit();
    await replica.onModuleInit();
    const issued = await registry.issue({
      userId: 'service-1',
      role: 'trader',
      label: 'integration',
      ownerType: 'SERVICE',
      scopes: ['trading:read'],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    expect(JSON.stringify(query.mock.calls)).not.toContain(issued.apiKey);
    expect((await replica.authenticate(issued.apiKey)).scopes).toEqual(['trading:read']);

    const rotated = await replica.rotate(issued.metadata.keyId);
    expect(rotated.apiKey).not.toBe(issued.apiKey);
    await expect(registry.authenticate(issued.apiKey)).rejects.toThrow();
    expect(JSON.stringify(query.mock.calls)).not.toContain(rotated.apiKey);

    expect((await registry.authenticate(rotated.apiKey)).keyId).toBe(issued.metadata.keyId);
    await registry.revoke(issued.metadata.keyId);
    await expect(replica.authenticate(rotated.apiKey)).rejects.toThrow();
  });
});
