import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import type { Pool, QueryResultRow } from 'pg';
import { POSTGRES_POOL } from '../../../infrastructure/postgres';
import type { UserRecord } from '../domain/identity.types';
import type { UserStore } from '../ports/identity.ports';

type UserRow = QueryResultRow & {
  id: string;
  email_normalized: string;
  name: string;
  password_hash: string;
  roles: string[];
  scopes: string[];
  email_verified_at: Date | null;
  password_reset_required: boolean;
  security_version: number;
  created_at: Date;
  updated_at: Date;
};

/** PostgreSQL source of truth users/credentials; запросы параметризованы и не выбирают plaintext secrets. */
@Injectable()
export class PostgresUserStore implements UserStore {
  constructor(@Inject(POSTGRES_POOL) private readonly pool: Pool) {}

  async create(
    input: Readonly<{ emailNormalized: string; name: string; passwordHash: string }>,
  ): Promise<UserRecord> {
    try {
      const result = await this.pool.query<UserRow>(
        `INSERT INTO identity_users (email_normalized, name, password_hash) VALUES ($1,$2,$3) RETURNING *`,
        [input.emailNormalized, input.name, input.passwordHash],
      );
      return this.map(result.rows[0]);
    } catch (error) {
      if (this.code(error) === '23505')
        throw new ConflictException({
          code: 'AUTH_REGISTRATION_FAILED',
          message: 'Registration could not be completed',
        });
      throw error;
    }
  }
  async findByEmail(email: string): Promise<UserRecord | null> {
    const result = await this.pool.query<UserRow>(
      'SELECT * FROM identity_users WHERE email_normalized=$1',
      [email],
    );
    return result.rows[0] ? this.map(result.rows[0]) : null;
  }
  async findById(id: string): Promise<UserRecord | null> {
    const result = await this.pool.query<UserRow>('SELECT * FROM identity_users WHERE id=$1', [id]);
    return result.rows[0] ? this.map(result.rows[0]) : null;
  }
  async updateName(id: string, name: string): Promise<UserRecord> {
    return this.update(
      'UPDATE identity_users SET name=$2, updated_at=clock_timestamp() WHERE id=$1 RETURNING *',
      [id, name],
    );
  }
  async updatePassword(id: string, hash: string, requireReset = false): Promise<UserRecord> {
    return this.update(
      'UPDATE identity_users SET password_hash=$2, password_reset_required=$3, security_version=security_version+1, updated_at=clock_timestamp() WHERE id=$1 RETURNING *',
      [id, hash, requireReset],
    );
  }
  async rehashPassword(id: string, previousHash: string, hash: string): Promise<void> {
    await this.pool.query(
      `UPDATE identity_users SET password_hash=$3, updated_at=clock_timestamp()
        WHERE id=$1 AND password_hash=$2`,
      [id, previousHash, hash],
    );
  }
  async markEmailVerified(id: string): Promise<UserRecord> {
    return this.update(
      'UPDATE identity_users SET email_verified_at=COALESCE(email_verified_at,clock_timestamp()), updated_at=clock_timestamp() WHERE id=$1 RETURNING *',
      [id],
    );
  }

  async issueChallenge(
    input: Readonly<{
      userId: string;
      kind: 'EMAIL_VERIFY' | 'PASSWORD_RESET';
      digest: string;
      expiresAt: string;
    }>,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE identity_challenges SET consumed_at=clock_timestamp()
          WHERE user_id=$1 AND kind=$2 AND consumed_at IS NULL`,
        [input.userId, input.kind],
      );
      await client.query(
        `INSERT INTO identity_challenges (user_id, kind, token_digest, expires_at, security_version)
         SELECT id,$2,$3,$4,security_version FROM identity_users WHERE id=$1`,
        [input.userId, input.kind, input.digest, input.expiresAt],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async invalidateChallenge(
    kind: 'EMAIL_VERIFY' | 'PASSWORD_RESET',
    digest: string,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE identity_challenges SET consumed_at=clock_timestamp()
        WHERE kind=$1 AND token_digest=$2 AND consumed_at IS NULL`,
      [kind, digest],
    );
  }

  async consumeChallenge(
    kind: 'EMAIL_VERIFY' | 'PASSWORD_RESET',
    digest: string,
  ): Promise<UserRecord | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const challenge = await client.query<{ user_id: string }>(
        `UPDATE identity_challenges c SET consumed_at=clock_timestamp()
          FROM identity_users u
         WHERE c.user_id=u.id AND c.kind=$1 AND c.token_digest=$2
           AND c.consumed_at IS NULL AND c.expires_at>clock_timestamp()
           AND c.security_version=u.security_version
         RETURNING c.user_id`,
        [kind, digest],
      );
      const user = challenge.rows[0]
        ? await client.query<UserRow>('SELECT * FROM identity_users WHERE id=$1', [
            challenge.rows[0].user_id,
          ])
        : null;
      await client.query('COMMIT');
      return user?.rows[0] ? this.map(user.rows[0]) : null;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async completePasswordReset(digest: string, passwordHash: string): Promise<UserRecord | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const challenge = await client.query<{ user_id: string }>(
        `UPDATE identity_challenges c SET consumed_at=clock_timestamp()
          FROM identity_users u
         WHERE c.user_id=u.id AND c.kind='PASSWORD_RESET' AND c.token_digest=$1
           AND c.consumed_at IS NULL AND c.expires_at>clock_timestamp()
           AND c.security_version=u.security_version
         RETURNING c.user_id`,
        [digest],
      );
      const userId = challenge.rows[0]?.user_id;
      if (!userId) {
        await client.query('ROLLBACK');
        return null;
      }
      await client.query(
        `UPDATE identity_challenges SET consumed_at=clock_timestamp()
          WHERE user_id=$1 AND kind='PASSWORD_RESET' AND consumed_at IS NULL`,
        [userId],
      );
      const updated = await client.query<UserRow>(
        `UPDATE identity_users SET password_hash=$2, password_reset_required=FALSE,
           security_version=security_version+1, updated_at=clock_timestamp()
         WHERE id=$1 RETURNING *`,
        [userId, passwordHash],
      );
      await client.query('COMMIT');
      return updated.rows[0] ? this.map(updated.rows[0]) : null;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async cleanupExpiredChallenges(limit: number): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM identity_challenges
        WHERE id IN (
          SELECT id FROM identity_challenges
           WHERE expires_at<clock_timestamp() OR consumed_at IS NOT NULL
           ORDER BY id LIMIT $1
        )`,
      [limit],
    );
    return result.rowCount ?? 0;
  }

  private async update(sql: string, values: readonly unknown[]): Promise<UserRecord> {
    const result = await this.pool.query<UserRow>(sql, values as unknown[]);
    if (!result.rows[0])
      throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'User was not found' });
    return this.map(result.rows[0]);
  }
  private map(row: UserRow | undefined): UserRecord {
    if (!row) throw new Error('IDENTITY_USER_ROW_MISSING');
    return {
      id: row.id,
      emailNormalized: row.email_normalized,
      name: row.name,
      passwordHash: row.password_hash,
      roles: row.roles as UserRecord['roles'],
      scopes: row.scopes,
      emailVerifiedAt: row.email_verified_at?.toISOString() ?? null,
      passwordResetRequired: row.password_reset_required,
      securityVersion: row.security_version,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }
  private code(error: unknown): string | undefined {
    return typeof error === 'object' && error !== null && 'code' in error
      ? String(error.code)
      : undefined;
  }
}
