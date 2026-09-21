import { Inject } from '@nestjs/common';
import { POSTGRES_TRANSACTION, PostgresTransactionManager } from '../../../infrastructure/postgres';
import type {
  AdmissionContext,
  AdmissionControlChange,
  AdmissionControlPort,
} from '../ports/admission-control.port';
import {
  AdmissionControlUnavailableError,
  AdmissionRejectedError,
} from '../ports/admission-control.port';

/** PostgreSQL control plane, восстанавливаемый до открытия command admission. */
export class PostgresAdmissionControl implements AdmissionControlPort {
  /** Создаёт adapter поверх общей audit/admin transaction boundary. */
  constructor(
    @Inject(POSTGRES_TRANSACTION) private readonly transactions: PostgresTransactionManager,
  ) {}

  /**
   * Записывает immutable history и current state одной transaction.
   * Повтор command ID безопасен; несовместимый повтор отклоняется constraint.
   */
  apply(change: AdmissionControlChange): Promise<void> {
    return this.transactions.run(async (client) => {
      const duplicate = await client.query<{
        control_type: string;
        target_id: string;
        state: string;
      }>(
        'SELECT control_type, target_id, state FROM admission_control_history WHERE command_id=$1',
        [change.commandId],
      );
      if (duplicate.rows[0]) {
        const row = duplicate.rows[0];
        if (
          row.control_type !== change.type ||
          row.target_id !== change.targetId ||
          row.state !== change.state
        ) {
          throw new Error('ADMISSION_CONTROL_COMMAND_REUSED');
        }
        return;
      }
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `admission:${change.type}:${change.targetId}`,
      ]);
      const current = await client.query<{ version: string }>(
        'SELECT version FROM admission_controls WHERE control_type=$1 AND target_id=$2 FOR UPDATE',
        [change.type, change.targetId],
      );
      const version = Number(current.rows[0]?.version ?? 0) + 1;
      await client.query(
        `INSERT INTO admission_control_history
          (command_id, control_type, target_id, state, version, effective_at,
           actor_id, reason_code, compensation_for)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          change.commandId,
          change.type,
          change.targetId,
          change.state,
          version,
          change.effectiveAt,
          change.actorId,
          change.reasonCode,
          change.compensationFor ?? null,
        ],
      );
      await client.query(
        `INSERT INTO admission_controls
          (control_type,target_id,state,version,effective_at,command_id,actor_id,reason_code)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (control_type,target_id) DO UPDATE
         SET state=EXCLUDED.state, version=EXCLUDED.version,
             effective_at=EXCLUDED.effective_at, command_id=EXCLUDED.command_id,
             actor_id=EXCLUDED.actor_id, reason_code=EXCLUDED.reason_code,
             updated_at=clock_timestamp()`,
        [
          change.type,
          change.targetId,
          change.state,
          version,
          change.effectiveAt,
          change.commandId,
          change.actorId,
          change.reasonCode,
        ],
      );
    });
  }

  /**
   * Проверяет все active controls одним bounded indexed query и работает
   * fail-closed: недоступность PostgreSQL запрещает durable acceptance.
   */
  async assertAllowed(context: AdmissionContext, at = new Date()): Promise<void> {
    try {
      await this.transactions.run(async (client) => {
        const result = await client.query<{ control_type: string; state: string }>(
          `SELECT control_type, state FROM admission_controls
            WHERE effective_at <= $1 AND (
              (control_type='GLOBAL' AND target_id='*') OR
              (control_type='USER' AND target_id=$2) OR
              (control_type='ACCOUNT' AND target_id=$3) OR
              (control_type='INSTRUMENT' AND target_id=$4)
            )`,
          [at, context.userId, context.accountId, context.instrumentId],
        );
        const blocked = new Map(result.rows.map((row) => [row.control_type, row.state]));
        if (blocked.get('GLOBAL') === 'OPEN' || blocked.get('INSTRUMENT') === 'OPEN') {
          throw new AdmissionRejectedError('CIRCUIT_BREAKER_OPEN');
        }
        if (blocked.get('USER') === 'FROZEN') throw new AdmissionRejectedError('USER_FROZEN');
        if (blocked.get('ACCOUNT') === 'FROZEN') {
          throw new AdmissionRejectedError('ACCOUNT_FROZEN');
        }
        if (blocked.get('INSTRUMENT') === 'PAUSED') {
          throw new AdmissionRejectedError('INSTRUMENT_PAUSED');
        }
      });
    } catch (error) {
      if (error instanceof AdmissionRejectedError) throw error;
      throw new AdmissionControlUnavailableError();
    }
  }

  /** Возвращает current control snapshot без historical secrets. */
  list(): Promise<readonly AdmissionControlChange[]> {
    return this.transactions.run(async (client) => {
      const result = await client.query<{
        command_id: string;
        control_type: AdmissionControlChange['type'];
        target_id: string;
        state: AdmissionControlChange['state'];
        effective_at: Date;
        actor_id: string;
        reason_code: string;
      }>('SELECT * FROM admission_controls ORDER BY control_type, target_id');
      return result.rows.map((row) => ({
        commandId: row.command_id,
        type: row.control_type,
        targetId: row.target_id,
        state: row.state,
        effectiveAt: row.effective_at,
        actorId: row.actor_id,
        reasonCode: row.reason_code,
      }));
    });
  }

  /** Выполняет read-only readiness probe current control table. */
  checkReady(): Promise<void> {
    return this.transactions.run(
      async (client) => {
        await client.query('SELECT 1 FROM admission_controls LIMIT 1');
      },
      { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    );
  }
}
