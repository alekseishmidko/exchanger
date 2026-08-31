import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client } from 'pg';

const postgresUrl = process.env['POSTGRES_URL'];
const describePostgres = postgresUrl ? describe : describe.skip;

/** Запускает integration tests только при явно предоставленной PostgreSQL. */
describePostgres('Ledger PostgreSQL migrations', () => {
  let client: Client;
  const migrationPath = (name: string): string => resolve(__dirname, 'migrations', name);

  beforeAll(async () => {
    client = new Client({ connectionString: postgresUrl });
    await client.connect();
    await client.query(await readFile(migrationPath('001_ledger_down.sql'), 'utf8'));
    await client.query(await readFile(migrationPath('001_ledger_up.sql'), 'utf8'));
  });

  afterAll(async () => {
    await client.query(await readFile(migrationPath('001_ledger_down.sql'), 'utf8'));
    await client.end();
  });

  it('creates constraints and supports up/down migration', async () => {
    await client.query("INSERT INTO assets (id, code, scale) VALUES ('usd', 'USD', 2)");
    await client.query("INSERT INTO accounts (id, owner_id) VALUES ('account-1', 'user-1')");
    await client.query(
      "INSERT INTO balances (account_id, asset_id, available, reserved) VALUES ('account-1', 'usd', 10, 0)",
    );

    await expect(
      client.query(
        "INSERT INTO balances (account_id, asset_id, available, reserved) VALUES ('account-1', 'usd', -1, 0)",
      ),
    ).rejects.toThrow();
    await expect(client.query('SELECT 1 FROM postings')).resolves.toBeDefined();
  });
});
