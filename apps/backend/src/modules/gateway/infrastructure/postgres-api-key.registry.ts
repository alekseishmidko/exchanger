import { ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { randomBytes } from 'node:crypto';
import type { PostgresTransactionManager } from '../../../infrastructure/postgres';
import {
  ApiKeyCredential,
  ApiKeyMetadata,
  ApiKeyPrincipal,
  ApiKeyRegistry,
  IssuedApiKey,
} from '../auth/gateway.auth';

type ApiKeyRow = QueryResultRow & {
  key_id: string;
  secret_digest: string;
  owner_id: string;
  owner_type: 'USER' | 'SERVICE' | 'SYSTEM';
  role: ApiKeyMetadata['role'];
  label: string;
  scopes: string[];
  expires_at: Date;
  status: 'ACTIVE' | 'REVOKED';
  created_at: Date;
  rotated_at: Date | null;
  revoked_at: Date | null;
  last_used_at: Date | null;
};

/**
 * Durable machine credential registry.
 * Каждый authentication/revalidation обращается к PostgreSQL source of truth;
 * startup snapshot нужен только для локального генератора новых keyId и никогда
 * не участвует в допуске. Raw secret существует лишь в stack первого response.
 */
@Injectable()
export class PostgresApiKeyRegistry extends ApiKeyRegistry implements OnModuleInit {
  constructor(
    private readonly pool: Pool,
    private readonly transactions?: PostgresTransactionManager,
  ) {
    super([]);
  }

  async onModuleInit(): Promise<void> {
    const rows = await this.pool.query<ApiKeyRow>('SELECT * FROM machine_api_keys');
    this.credentials.clear();
    this.keyIdByDigest.clear();
    for (const row of rows.rows) {
      const credential = this.map(row);
      this.credentials.set(row.key_id, credential);
      if (credential.metadata.status === 'ACTIVE')
        this.keyIdByDigest.set(credential.digest, row.key_id);
    }
  }

  /**
   * Проверяет credential непосредственно в PostgreSQL source of truth.
   * Локальная replica не может принять stale digest после rotate/revoke другой
   * replica; raw key преобразуется в digest до query и нигде не сохраняется.
   */
  override async authenticate(value: string | undefined): Promise<ApiKeyPrincipal> {
    if (!value || value.length < 16 || value.length > 256) return super.authenticate(undefined);
    const result = await this.database().query<ApiKeyRow>(
      `UPDATE machine_api_keys
          SET last_used_at=clock_timestamp()
        WHERE secret_digest=$1 AND status='ACTIVE' AND expires_at>clock_timestamp()
        RETURNING *`,
      [this.digest(value)],
    );
    const row = result.rows[0];
    if (!row) return super.authenticate(undefined);
    return {
      keyId: row.key_id,
      role: row.role,
      userId: row.owner_id,
      scopes: row.scopes,
    };
  }

  /** Проверяет live status долгоживущего principal без raw API key. */
  override async isPrincipalActive(principal: ApiKeyPrincipal): Promise<boolean> {
    const result = await this.database().query<{ active: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM machine_api_keys
          WHERE key_id=$1 AND owner_id=$2 AND role=$3 AND scopes=$4::text[]
            AND status='ACTIVE' AND expires_at>clock_timestamp()
       ) AS active`,
      [principal.keyId, principal.userId, principal.role, principal.scopes ?? []],
    );
    return result.rows[0]?.active === true;
  }

  /** Возвращает актуальные metadata со всех replicas без process-local snapshot. */
  override async list(): Promise<readonly ApiKeyMetadata[]> {
    const rows = await this.database().query<ApiKeyRow>(
      'SELECT * FROM machine_api_keys ORDER BY key_id',
    );
    return rows.rows.map((row) => this.map(row).metadata);
  }

  override async issue(
    input: Parameters<ApiKeyRegistry['issue']>[0],
    now = new Date(),
  ): Promise<IssuedApiKey> {
    const issued = await super.issue(input, now);
    const credential = this.requireCredential(issued.metadata.keyId);
    try {
      await this.database().query(
        `INSERT INTO machine_api_keys (key_id,secret_digest,owner_id,owner_type,role,label,scopes,expires_at,status,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ACTIVE',$9)`,
        [
          issued.metadata.keyId,
          credential.digest,
          issued.metadata.userId,
          issued.metadata.ownerType,
          issued.metadata.role,
          issued.metadata.label,
          issued.metadata.scopes,
          issued.metadata.expiresAt,
          issued.metadata.createdAt,
        ],
      );
      return issued;
    } catch (error) {
      this.credentials.delete(issued.metadata.keyId);
      this.keyIdByDigest.delete(credential.digest);
      throw error;
    }
  }

  override async rotate(keyId: string, now = new Date()): Promise<IssuedApiKey> {
    const apiKey = `ex_${randomBytes(32).toString('base64url')}`;
    const expiresAt = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000).toISOString();
    const result = await this.database().query<ApiKeyRow>(
      `UPDATE machine_api_keys SET secret_digest=$2, expires_at=$3,
         rotated_at=$4, last_used_at=NULL
       WHERE key_id=$1 AND status='ACTIVE' RETURNING *`,
      [keyId, this.digest(apiKey), expiresAt, now.toISOString()],
    );
    if (!result.rows[0]) {
      const existing = await this.database().query<{ status: string }>(
        'SELECT status FROM machine_api_keys WHERE key_id=$1',
        [keyId],
      );
      if (!existing.rows[0])
        throw new NotFoundException({
          code: 'API_KEY_NOT_FOUND',
          message: 'API key was not found',
        });
      throw new ConflictException({ code: 'API_KEY_REVOKED', message: 'API key is revoked' });
    }
    return { apiKey, metadata: this.map(result.rows[0]).metadata };
  }

  override async revoke(keyId: string, now = new Date()): Promise<ApiKeyMetadata> {
    const result = await this.database().query<ApiKeyRow>(
      `UPDATE machine_api_keys SET status='REVOKED', revoked_at=COALESCE(revoked_at,$2)
        WHERE key_id=$1 RETURNING *`,
      [keyId, now.toISOString()],
    );
    if (!result.rows[0])
      throw new NotFoundException({ code: 'API_KEY_NOT_FOUND', message: 'API key was not found' });
    return this.map(result.rows[0]).metadata;
  }

  /** Выбирает transaction client idempotency boundary либо shared pool для read request. */
  private database(): Pool | PoolClient {
    if (!this.transactions) return this.pool;
    try {
      return this.transactions.currentClient();
    } catch {
      return this.pool;
    }
  }

  private map(row: ApiKeyRow): ApiKeyCredential {
    return {
      digest: row.secret_digest,
      metadata: {
        keyId: row.key_id,
        userId: row.owner_id,
        ownerType: row.owner_type,
        role: row.role,
        label: row.label,
        scopes: row.scopes,
        expiresAt: row.expires_at.toISOString(),
        status: row.status,
        createdAt: row.created_at.toISOString(),
        rotatedAt: row.rotated_at?.toISOString() ?? null,
        revokedAt: row.revoked_at?.toISOString() ?? null,
        lastUsedAt: row.last_used_at?.toISOString() ?? null,
      },
    };
  }
}
