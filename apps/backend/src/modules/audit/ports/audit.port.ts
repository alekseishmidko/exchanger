import type { AuditActor, AuditEventType, AuditRecord } from '../domain/audit-log';

/**
 * Стабильный DI-токен immutable audit boundary.
 *
 * Symbol исключает случайную коллизию строковых provider names и позволяет
 * заменить reference `AuditLog` на PostgreSQL/WORM adapter без изменения
 * административных application services.
 */
export const AUDIT_LOG_PORT = Symbol('AUDIT_LOG_PORT');

/**
 * Порт append-only бизнес-аудита.
 *
 * Application-модули зависят от этого контракта и не знают, хранит adapter
 * цепочку в памяти, PostgreSQL или WORM storage. Production-реализация обязана
 * атомарно назначать sequence, связывать `previousHash` и не предоставлять
 * update/delete методов.
 *
 * @example `audit.append(actor, 'ACTION_APPLIED', 'FREEZE_ACCOUNT', 'cmd-1', 'acc-1')`.
 */
export interface AuditLogPort {
  /**
   * Добавляет неизменяемую запись в конец tamper-evident цепочки.
   *
   * @param actor Identity, полученная из доверенного authentication context.
   * @param eventType Стадия административной операции.
   * @param actionType Тип бизнес-действия, например `FREEZE_ACCOUNT`.
   * @param commandId Идемпотентный идентификатор команды.
   * @param targetId Объект, над которым выполнено действие.
   * @param details Allow-list технических деталей без секретов.
   * @param occurredAt Контролируемое время события.
   * @returns Новая immutable запись с sequence и hash chain.
   */
  append(
    actor: AuditActor,
    eventType: AuditEventType,
    actionType: string,
    commandId: string,
    targetId: string,
    details?: Readonly<Record<string, string | number | boolean | null>>,
    occurredAt?: Date,
  ): AuditRecord | Promise<AuditRecord>;
  /**
   * Возвращает immutable snapshot цепочки для расследования/reconciliation.
   * Изменение возвращённого массива не должно менять сохранённый журнал.
   */
  getRecords(): readonly AuditRecord[] | Promise<readonly AuditRecord[]>;
  /**
   * Проверяет sequence, previousHash и hash всей переданной цепочки.
   *
   * @param records Цепочка для проверки; без аргумента используется live chain.
   * @returns `true`, только если удаление, перестановка и изменение не найдены.
   */
  verifyIntegrity(records?: readonly AuditRecord[]): boolean | Promise<boolean>;
}
