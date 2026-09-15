import { createHash } from 'node:crypto';
import { Inject } from '@nestjs/common';
import type { QueryResultRow } from 'pg';
import { POSTGRES_TRANSACTION, PostgresTransactionManager } from '../../infrastructure/postgres';
import { canonicalJson } from '../../infrastructure/postgres/postgres-json';
import type { AuditActor, AuditEventType, AuditRecord } from './audit-log';
import type { AuditLogPort } from './audit.port';

type AuditRow = QueryResultRow & {
  id: string;
  sequence: string;
  occurred_at: Date;
  actor_id: string;
  actor_role: AuditActor['role'];
  event_type: AuditEventType;
  action_type: string;
  command_id: string;
  target_id: string;
  details: Record<string, string | number | boolean | null>;
  previous_hash: string;
  hash: string;
};

/**
 * PostgreSQL adapter append-only tamper-evident audit chain.
 *
 * Advisory transaction lock сериализует append между replicas. Hash включает
 * sequence, timestamp, actor, action и previousHash. Database triggers запрещают
 * UPDATE/DELETE, поэтому исправление возможно только новой компенсирующей
 * записью. Adapter не принимает API keys, cookies или authorization headers.
 */
export class PostgresAuditLog implements AuditLogPort {
  /**
   * Создаёт audit adapter поверх общей transaction boundary.
   * @param transactions Менеджер, позволяющий audit войти в transaction команды.
   */
  constructor(
    @Inject(POSTGRES_TRANSACTION) private readonly transactions: PostgresTransactionManager,
  ) {}

  /** Атомарно назначает sequence, связывает hash chain и вставляет запись. */
  append(
    actor: AuditActor,
    eventType: AuditEventType,
    actionType: string,
    commandId: string,
    targetId: string,
    details: Readonly<Record<string, string | number | boolean | null>> = {},
    occurredAt: Date = new Date(),
  ): Promise<AuditRecord> {
    return this.transactions.run(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('audit-chain', 0))");
      const tail = await client.query<{ sequence: string; hash: string }>(
        'SELECT sequence, hash FROM audit_records ORDER BY sequence DESC LIMIT 1',
      );
      const sequence = Number(tail.rows[0]?.sequence ?? 0) + 1;
      const previousHash = tail.rows[0]?.hash ?? 'GENESIS';
      const body = {
        sequence,
        occurredAt: occurredAt.toISOString(),
        actor,
        eventType,
        actionType,
        commandId,
        targetId,
        details,
        previousHash,
      };
      const record: AuditRecord = {
        id: `audit-${sequence}`,
        ...body,
        hash: this.hash(body),
      };
      await client.query(
        `INSERT INTO audit_records
          (id, occurred_at, actor_id, actor_role, event_type, action_type,
           command_id, target_id, details, previous_hash, hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)`,
        [
          record.id,
          record.occurredAt,
          actor.actorId,
          actor.role,
          eventType,
          actionType,
          commandId,
          targetId,
          JSON.stringify(details),
          previousHash,
          record.hash,
        ],
      );
      return record;
    });
  }

  /** Возвращает всю цепочку в порядке sequence для reconciliation. */
  getRecords(): Promise<readonly AuditRecord[]> {
    return this.transactions.run(async (client) => {
      const result = await client.query<AuditRow>('SELECT * FROM audit_records ORDER BY sequence');
      return result.rows.map((row) => this.map(row));
    });
  }

  /** Пересчитывает hash chain перед выдачей integrity status. */
  async verifyIntegrity(records?: readonly AuditRecord[]): Promise<boolean> {
    const chain = records ?? (await this.getRecords());
    let previousHash = 'GENESIS';
    for (let index = 0; index < chain.length; index += 1) {
      const record = chain[index];
      if (!record || record.sequence !== index + 1 || record.previousHash !== previousHash) {
        return false;
      }
      const body = {
        sequence: record.sequence,
        occurredAt: record.occurredAt,
        actor: record.actor,
        eventType: record.eventType,
        actionType: record.actionType,
        commandId: record.commandId,
        targetId: record.targetId,
        details: record.details,
        previousHash: record.previousHash,
      };
      if (record.hash !== this.hash(body)) return false;
      previousHash = record.hash;
    }
    return true;
  }

  /** Преобразует database row в immutable domain-neutral audit DTO. */
  private map(row: AuditRow): AuditRecord {
    return {
      id: row.id,
      sequence: Number(row.sequence),
      occurredAt: row.occurred_at.toISOString(),
      actor: { actorId: row.actor_id, role: row.actor_role },
      eventType: row.event_type,
      actionType: row.action_type,
      commandId: row.command_id,
      targetId: row.target_id,
      details: row.details,
      previousHash: row.previous_hash,
      hash: row.hash,
    };
  }

  /** Вычисляет hash канонической формы, совпадающей между replicas. */
  private hash(value: object): string {
    return createHash('sha256').update(canonicalJson(value)).digest('hex');
  }
}
