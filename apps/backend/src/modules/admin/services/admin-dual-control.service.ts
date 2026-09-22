import { AuditActor } from '../../audit';
import { AdminCommand, PendingAdminAction } from '../types/admin.types';

/**
 * Хранилище pending dual-control операций внутри Admin application boundary.
 *
 * Пока durable approval store не выделен в отдельный adapter, этот сервис
 * инкапсулирует process-local pending map и не даёт фасаду `AdminService`
 * смешивать lifecycle approval с остальной административной логикой.
 */
export class AdminDualControlService {
  private readonly pending = new Map<string, PendingAdminAction>();

  /** Регистрирует команду, ожидающую независимого approver. */
  request(command: AdminCommand, requestedBy: AuditActor, requestedAt: Date): void {
    this.pending.set(command.commandId, { command, requestedBy, requestedAt });
  }

  /** Возвращает pending action по commandId либо `undefined`. */
  get(commandId: string): PendingAdminAction | undefined {
    return this.pending.get(commandId);
  }

  /** Удаляет action после успешного применения или компенсации. */
  complete(commandId: string): void {
    this.pending.delete(commandId);
  }

  /** Количество незавершённых approvals для reconciliation dashboard. */
  count(): number {
    return this.pending.size;
  }
}
