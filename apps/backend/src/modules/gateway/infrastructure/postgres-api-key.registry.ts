import { Injectable, OnModuleInit } from '@nestjs/common';
import type { Pool, QueryResultRow } from 'pg';
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
 * Startup загружает только digest+metadata; issue/rotate/revoke сначала фиксируют
 * PostgreSQL row и синхронизируют process cache. Raw secret существует только в
 * stack первого HTTP response и никогда не записывается в БД.
 */
@Injectable()
export class PostgresApiKeyRegistry extends ApiKeyRegistry implements OnModuleInit {
  constructor(private readonly pool: Pool) {
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

  /** Проверяет cache digest синхронно и best-effort фиксирует last-used metadata. */
  override authenticate(value: string | undefined): ApiKeyPrincipal {
    const principal = super.authenticate(value);
    void this.pool
      .query('UPDATE machine_api_keys SET last_used_at=clock_timestamp() WHERE key_id=$1', [
        principal.keyId,
      ])
      .catch(() => undefined);
    return principal;
  }

  override async issue(
    input: Parameters<ApiKeyRegistry['issue']>[0],
    now = new Date(),
  ): Promise<IssuedApiKey> {
    const issued = await super.issue(input, now);
    const credential = this.requireCredential(issued.metadata.keyId);
    try {
      await this.pool.query(
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
    const before = this.requireCredential(keyId);
    const issued = await super.rotate(keyId, now);
    const after = this.requireCredential(keyId);
    try {
      await this.pool.query(
        `UPDATE machine_api_keys SET secret_digest=$2, expires_at=$3, rotated_at=$4, last_used_at=NULL WHERE key_id=$1`,
        [keyId, after.digest, issued.metadata.expiresAt, issued.metadata.rotatedAt],
      );
      return issued;
    } catch (error) {
      this.credentials.set(keyId, before);
      this.keyIdByDigest.delete(after.digest);
      this.keyIdByDigest.set(before.digest, keyId);
      throw error;
    }
  }

  override async revoke(keyId: string, now = new Date()): Promise<ApiKeyMetadata> {
    const before = this.requireCredential(keyId);
    const metadata = await super.revoke(keyId, now);
    try {
      await this.pool.query(
        `UPDATE machine_api_keys SET status='REVOKED', revoked_at=$2 WHERE key_id=$1`,
        [keyId, metadata.revokedAt],
      );
      return metadata;
    } catch (error) {
      this.credentials.set(keyId, before);
      this.keyIdByDigest.set(before.digest, keyId);
      throw error;
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
