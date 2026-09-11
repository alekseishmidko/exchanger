import { createHash } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { LOG_EVENTS, StructuredLogger } from '../observability';

/** Роли сотрудников, имеющих доступ к административному контуру. */
export type AdministrativeRole = 'ADMIN' | 'RISK_MANAGER' | 'AUDITOR' | 'SUPPORT';

/**
 * Идентифицированный actor административного действия.
 *
 * `actorId` должен происходить из проверенной служебной identity, а не из payload
 * команды. Роль фиксируется в audit record на момент действия, чтобы последующее
 * изменение прав сотрудника не меняло исторический смысл записи.
 */
export type AuditActor = Readonly<{ actorId: string; role: AdministrativeRole }>;

/** Категории событий административного и контрольного контура. */
export type AuditEventType =
  | 'ACTION_REQUESTED'
  | 'ACTION_APPROVED'
  | 'ACTION_APPLIED'
  | 'ACTION_REJECTED'
  | 'COMPENSATION_APPLIED'
  | 'RECONCILIATION_EXECUTED';

/**
 * Неизменяемая запись аудита с криптографической связью с предыдущей записью.
 *
 * `details` содержит только allow-listed технические сведения и версии политик;
 * секреты, API keys и полные персональные данные сюда не записываются.
 */
export type AuditRecord = Readonly<{
  id: string;
  sequence: number;
  occurredAt: string;
  actor: AuditActor;
  eventType: AuditEventType;
  actionType: string;
  commandId: string;
  targetId: string;
  details: Readonly<Record<string, string | number | boolean | null>>;
  previousHash: string;
  hash: string;
}>;

/**
 * Append-only tamper-evident audit log.
 *
 * Каждая запись включает SHA-256 от нормализованных полей и `previousHash`.
 * Поэтому изменение, удаление или перестановка записи обнаруживается методом
 * `verifyIntegrity`. Это не заменяет WORM/object-lock storage: production adapter
 * обязан сохранять chain в отдельном durable audit-хранилище с retention policy.
 *
 * @example
 * ```ts
 * const record = log.append(actor, 'ACTION_APPLIED', 'FREEZE_ACCOUNT', 'cmd-1', 'account-1');
 * log.verifyIntegrity(); // true, пока цепочка не изменена.
 * ```
 */
@Injectable()
export class AuditLog {
  private readonly records: AuditRecord[] = [];

  constructor(@Optional() @Inject(StructuredLogger) private readonly logger?: StructuredLogger) {}

  /**
   * Добавляет запись в конец цепочки и возвращает immutable snapshot.
   *
   * @param actor Проверенный субъект действия.
   * @param eventType Этап жизненного цикла административной команды.
   * @param actionType Тип команды, например `EMERGENCY_STOP`.
   * @param commandId Идемпотентный идентификатор административной команды.
   * @param targetId Идентификатор затронутого объекта.
   * @param details Безопасные дополнительные поля для расследования.
   * @param occurredAt Контролируемое время для детерминированных тестов.
   */
  append(
    actor: AuditActor,
    eventType: AuditEventType,
    actionType: string,
    commandId: string,
    targetId: string,
    details: Readonly<Record<string, string | number | boolean | null>> = {},
    occurredAt: Date = new Date(),
  ): AuditRecord {
    const sequence = this.records.length + 1;
    const previousHash = this.records.at(-1)?.hash ?? 'GENESIS';
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
    const record = { id: `audit-${sequence}`, ...body, hash: this.hash(body) } as const;
    this.records.push(record);
    this.logger?.info('audit', LOG_EVENTS.AUDIT_RECORD_APPENDED, {
      commandId,
      metadata: { auditEventType: eventType, actionType, sequence },
    });
    return record;
  }

  /** Возвращает копию audit chain без возможности изменить внутренний массив. */
  getRecords(): readonly AuditRecord[] {
    return this.records.map((record) => ({
      ...record,
      actor: { ...record.actor },
      details: { ...record.details },
    }));
  }

  /**
   * Пересчитывает всю hash chain и обнаруживает изменение содержимого или порядка.
   *
   * @returns `true`, если sequence, previousHash и hash каждой записи согласованы.
   */
  verifyIntegrity(records: readonly AuditRecord[] = this.records): boolean {
    let previousHash = 'GENESIS';
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (!record || record.sequence !== index + 1 || record.previousHash !== previousHash) {
        this.logger?.failure('audit', LOG_EVENTS.AUDIT_INTEGRITY_FAILED, {
          metadata: { sequence: index + 1, reason: 'CHAIN_MISMATCH' },
        });
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
      const { hash } = record;
      if (hash !== this.hash(body)) {
        this.logger?.failure('audit', LOG_EVENTS.AUDIT_INTEGRITY_FAILED, {
          metadata: { sequence: record.sequence, reason: 'HASH_MISMATCH' },
        });
        return false;
      }
      previousHash = hash;
    }
    return true;
  }

  private hash(value: object): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }
}
