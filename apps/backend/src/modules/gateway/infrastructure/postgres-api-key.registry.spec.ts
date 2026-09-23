import type { Pool } from 'pg';
import { PostgresApiKeyRegistry } from './postgres-api-key.registry';

/** Canary test: durable machine credential SQL receives digest/metadata, never raw API key. */
describe('PostgresApiKeyRegistry', () => {
  it('persists issue/rotate/revoke without plaintext secret', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    const registry = new PostgresApiKeyRegistry({ query } as unknown as Pool);
    await registry.onModuleInit();
    const issued = await registry.issue({
      userId: 'service-1',
      role: 'trader',
      label: 'integration',
      ownerType: 'SERVICE',
      scopes: ['trading:read'],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    expect(JSON.stringify(query.mock.calls)).not.toContain(issued.apiKey);
    expect(registry.authenticate(issued.apiKey).scopes).toEqual(['trading:read']);

    const rotated = await registry.rotate(issued.metadata.keyId);
    expect(rotated.apiKey).not.toBe(issued.apiKey);
    expect(() => registry.authenticate(issued.apiKey)).toThrow();
    expect(JSON.stringify(query.mock.calls)).not.toContain(rotated.apiKey);

    await registry.revoke(issued.metadata.keyId);
    expect(() => registry.authenticate(rotated.apiKey)).toThrow();
  });
});
