import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Migration contract запрещает plaintext credential columns и фиксирует integrity constraints. */
describe('identity migration', () => {
  it('creates users, one-time digests, API-key digests and no session-token table', () => {
    const sql = readFileSync(
      resolve(__dirname, '../../../infrastructure/postgres/migrations/004_identity_up.sql'),
      'utf8',
    );
    expect(sql).toContain('CREATE TABLE identity_users');
    expect(sql).toContain('CREATE UNIQUE INDEX identity_users_email_ci_unique');
    expect(sql).toContain('token_digest TEXT NOT NULL UNIQUE');
    expect(sql).toContain('secret_digest TEXT NOT NULL UNIQUE');
    expect(sql).not.toMatch(/session_token|api_key_secret|plaintext_password/i);
    expect(sql).not.toContain('CREATE TABLE identity_sessions');
  });

  it('adds challenge security version and trading read scope without plaintext migration data', () => {
    const sql = readFileSync(
      resolve(
        __dirname,
        '../../../infrastructure/postgres/migrations/005_security_hardening_up.sql',
      ),
      'utf8',
    );
    expect(sql).toContain('security_version INTEGER');
    expect(sql).toContain("'trading:read'");
    expect(sql).not.toMatch(/password\s*=|token\s*=|api.?key\s*=/i);
  });
});
