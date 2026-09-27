import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('realtime market migration', () => {
  it('creates guarded catalog and immutable sync history', () => {
    const sql = readFileSync(
      resolve(__dirname, '../../../infrastructure/postgres/migrations/006_realtime_market_up.sql'),
      'utf8',
    );
    expect(sql).toContain('CREATE TABLE realtime_instruments');
    expect(sql).toContain('CREATE TABLE realtime_catalog_sync_runs');
    expect(sql).toContain('CREATE TABLE realtime_instrument_staging');
    expect(sql).toContain('price_enabled BOOLEAN NOT NULL DEFAULT false');
    expect(sql).toContain('REVOKE UPDATE, DELETE ON realtime_catalog_sync_runs');
  });

  it('creates atomic realtime execution journal, quote snapshots and controls', () => {
    const sql = readFileSync(
      resolve(
        __dirname,
        '../../../infrastructure/postgres/migrations/007_realtime_execution_up.sql',
      ),
      'utf8',
    );
    expect(sql).toContain('CREATE TABLE realtime_commands');
    expect(sql).toContain('CREATE TABLE realtime_execution_quotes');
    expect(sql).toContain('CREATE TABLE realtime_executions');
    expect(sql).toContain('CREATE TABLE realtime_execution_controls');
    expect(sql).toContain('realtime_execution_quotes_are_immutable');
    expect(sql).toContain('UNIQUE (identity_key, idempotency_key_digest)');
  });
});
