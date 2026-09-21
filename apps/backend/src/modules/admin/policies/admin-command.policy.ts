import { ForbiddenException } from '@nestjs/common';
import { AuditActor, AuditLogPort, AdministrativeRole } from '../../audit';
import { LOG_EVENTS, StructuredLogger } from '../../observability';
import { AdminCommand, AdminResult } from '../types/admin.types';

/** Тип административного действия плюс служебное reconciliation-действие. */
export type AdminAuthorizableAction = AdminCommand['type'] | 'RECONCILIATION';

const ALLOWED_ROLES: Record<AdminAuthorizableAction, readonly AdministrativeRole[]> = {
  CONFIGURE_INSTRUMENT: ['ADMIN', 'RISK_MANAGER'],
  ACTIVATE_INSTRUMENT: ['ADMIN', 'RISK_MANAGER'],
  PAUSE_INSTRUMENT: ['ADMIN', 'RISK_MANAGER'],
  CHANGE_FEE_POLICY: ['ADMIN', 'RISK_MANAGER'],
  CHANGE_RISK_POLICY: ['RISK_MANAGER'],
  FREEZE_USER: ['ADMIN', 'RISK_MANAGER'],
  UNFREEZE_USER: ['ADMIN', 'RISK_MANAGER'],
  FREEZE_ACCOUNT: ['ADMIN', 'RISK_MANAGER'],
  UNFREEZE_ACCOUNT: ['ADMIN', 'RISK_MANAGER'],
  EMERGENCY_STOP: ['ADMIN'],
  RESUME_TRADING: ['ADMIN'],
  RECONCILIATION: ['ADMIN', 'AUDITOR'],
};

/**
 * Проверяет роль actor и пишет отказ в audit до выбрасывания ошибки.
 *
 * Это чистая application policy вокруг role matrix: она не применяет команду и
 * не меняет state, но гарантирует, что forbidden попытка остаётся видимой в
 * immutable audit и operational logs.
 */
export async function assertAdminRole(
  type: AdminAuthorizableAction,
  actor: AuditActor,
  commandId: string,
  targetId: string,
  audit: AuditLogPort,
  logger?: StructuredLogger,
): Promise<void> {
  if (!ALLOWED_ROLES[type].includes(actor.role)) {
    await audit.append(actor, 'ACTION_REJECTED', type, commandId, targetId, {
      reason: 'ROLE_FORBIDDEN',
    });
    logger?.warn('admin', LOG_EVENTS.ADMIN_ACTION_REJECTED, {
      commandId,
      metadata: { actionType: type, reason: 'ROLE_FORBIDDEN' },
    });
    throw new ForbiddenException({
      code: 'ADMIN_FORBIDDEN',
      message: 'Administrative action is forbidden',
    });
  }
}

/**
 * Возвращает true для команд, где требуется независимое подтверждение.
 *
 * Freeze/unfreeze остаются одношаговыми операциями, а изменение торговых правил,
 * circuit breaker и lifecycle инструмента требуют второго actor.
 */
export function requiresDualControl(type: AdminCommand['type']): boolean {
  return [
    'CONFIGURE_INSTRUMENT',
    'ACTIVATE_INSTRUMENT',
    'PAUSE_INSTRUMENT',
    'CHANGE_FEE_POLICY',
    'CHANGE_RISK_POLICY',
    'EMERGENCY_STOP',
    'RESUME_TRADING',
  ].includes(type);
}

/** Собирает публичный результат административной команды без внутренних details. */
export function buildAdminResult(
  command: AdminCommand,
  status: AdminResult['status'],
  approvedBy: readonly string[],
): AdminResult {
  return {
    commandId: command.commandId,
    actionType: command.type,
    targetId: command.targetId,
    status,
    approvedBy,
  };
}

/**
 * Возвращает компенсирующую команду для обратимых operational controls.
 *
 * Policy/configuration не откатываются прямым удалением: для них нужна новая
 * версия правил, чтобы audit chain оставался append-only.
 */
export function reverseAdminCommandType(type: AdminCommand['type']): AdminCommand['type'] {
  const reverse: Partial<Record<AdminCommand['type'], AdminCommand['type']>> = {
    FREEZE_USER: 'UNFREEZE_USER',
    UNFREEZE_USER: 'FREEZE_USER',
    FREEZE_ACCOUNT: 'UNFREEZE_ACCOUNT',
    UNFREEZE_ACCOUNT: 'FREEZE_ACCOUNT',
    EMERGENCY_STOP: 'RESUME_TRADING',
    RESUME_TRADING: 'EMERGENCY_STOP',
    ACTIVATE_INSTRUMENT: 'PAUSE_INSTRUMENT',
    PAUSE_INSTRUMENT: 'ACTIVATE_INSTRUMENT',
  };
  const result = reverse[type];
  if (!result) throw new Error('Action requires a new version instead of direct compensation');
  return result;
}
