import { ForbiddenException, Inject, Injectable, Optional } from '@nestjs/common';
import { AUDIT_LOG_PORT, AuditActor, AuditLogPort, AuditRecord } from '../audit';
import { InstrumentCatalogService } from '../trading/instruments';
import { LOG_EVENTS, MetricsService, StructuredLogger } from '../observability';
import {
  ADMISSION_CONTROL_PORT,
  AdmissionControlChange,
  AdmissionControlPort,
} from './ports/admission-control.port';
import {
  assertAdminRole,
  buildAdminResult,
  requiresDualControl,
  reverseAdminCommandType,
} from './policies/admin-command.policy';
import { AdminPolicyRegistry } from './policies/admin-policy-registry.service';
import {
  AdminCommand,
  AdminResult,
  FeePolicy,
  PendingAdminAction,
  ReconciliationDashboard,
  RiskPolicy,
} from './types/admin.types';
import { MemoryAdmissionControl } from './infrastructure/memory-admission-control';

export type { AdminCommand, AdminResult, FeePolicy, ReconciliationDashboard, RiskPolicy };

/**
 * Единственная administrative write boundary для instruments, risk и controls.
 *
 * Сервис сначала проверяет role matrix, затем административную идемпотентность.
 * Критические действия не применяются сразу: первый actor создаёт pending action,
 * второй независимый actor подтверждает его через `approve`. Каждая стадия
 * записывается в tamper-evident `AuditLog`.
 *
 * Повтор `commandId` никогда не создаёт второе изменение. Исходные записи не
 * удаляются: обратимое operational state меняется только новой компенсирующей
 * командой, связанной с исходным command ID в audit details.
 */
@Injectable()
export class AdminService {
  private readonly pending = new Map<string, PendingAdminAction>();
  private readonly results = new Map<string, AdminResult>();
  private readonly commands = new Map<string, AdminCommand>();
  private readonly frozenUsers = new Set<string>();
  private readonly frozenAccounts = new Set<string>();
  private readonly stoppedTargets = new Set<string>();

  /**
   * Создаёт административную application boundary.
   *
   * Audit log остаётся обязательной бизнес-зависимостью. Operational logger и
   * metrics дополняют, но не заменяют immutable audit: открытие circuit breaker
   * отражается gauge, а нарушение reconciliation — отдельным counter.
   *
   * @param audit Tamper-evident журнал всех административных решений.
   * @param instruments Каталог версионированных правил и lifecycle инструментов.
   * @param logger Необязательный operational logger для runtime диагностики.
   * @param metrics Необязательные circuit-breaker/reconciliation метрики.
   */
  constructor(
    @Inject(AUDIT_LOG_PORT) private readonly audit: AuditLogPort,
    private readonly instruments: InstrumentCatalogService = new InstrumentCatalogService(),
    @Optional() @Inject(StructuredLogger) private readonly logger?: StructuredLogger,
    @Optional() @Inject(MetricsService) private readonly metrics?: MetricsService,
    @Optional()
    @Inject(ADMISSION_CONTROL_PORT)
    private readonly admission: AdmissionControlPort = new MemoryAdmissionControl(),
    @Optional()
    private readonly policies: AdminPolicyRegistry = new AdminPolicyRegistry(),
  ) {}

  /**
   * Запрашивает административное действие.
   *
   * Freeze/unfreeze применяется одним уполномоченным actor. Изменение инструмента,
   * fee/risk policy и emergency stop требуют dual control и возвращают
   * `PENDING_APPROVAL` до отдельного вызова `approve` другим сотрудником.
   */
  async request(command: AdminCommand, actor: AuditActor, now = new Date()): Promise<AdminResult> {
    const previous = this.results.get(command.commandId);
    if (previous) return previous;
    await this.assertRole(command.type, actor, command.commandId, command.targetId);
    this.commands.set(command.commandId, command);
    await this.audit.append(
      actor,
      'ACTION_REQUESTED',
      command.type,
      command.commandId,
      command.targetId,
      {},
      now,
    );
    if (requiresDualControl(command.type)) {
      const result = buildAdminResult(command, 'PENDING_APPROVAL', [actor.actorId]);
      this.pending.set(command.commandId, { command, requestedBy: actor, requestedAt: now });
      this.results.set(command.commandId, result);
      return result;
    }
    await this.apply(command, actor, now);
    const result = buildAdminResult(command, 'APPLIED', [actor.actorId]);
    this.results.set(command.commandId, result);
    await this.audit.append(
      actor,
      'ACTION_APPLIED',
      command.type,
      command.commandId,
      command.targetId,
      {},
      now,
    );
    this.logger?.info('admin', LOG_EVENTS.ADMIN_ACTION_APPLIED, {
      commandId: command.commandId,
      metadata: { actionType: command.type, status: result.status },
    });
    return result;
  }

  /**
   * Подтверждает pending action вторым независимым actor и применяет его один раз.
   *
   * @throws ForbiddenException Если approver совпадает с инициатором или его роль
   * не разрешает соответствующее действие.
   */
  async approve(commandId: string, actor: AuditActor, now = new Date()): Promise<AdminResult> {
    const current = this.results.get(commandId);
    if (current?.status === 'APPLIED') return current;
    const pending = this.pending.get(commandId);
    if (!pending) throw new Error('Pending administrative action does not exist');
    await this.assertRole(pending.command.type, actor, commandId, pending.command.targetId);
    if (pending.requestedBy.actorId === actor.actorId)
      throw new ForbiddenException({
        code: 'DUAL_CONTROL_REQUIRED',
        message: 'Independent approval is required',
      });
    await this.audit.append(
      actor,
      'ACTION_APPROVED',
      pending.command.type,
      commandId,
      pending.command.targetId,
      { requestedBy: pending.requestedBy.actorId },
      now,
    );
    await this.apply(pending.command, actor, now);
    const result = buildAdminResult(pending.command, 'APPLIED', [
      pending.requestedBy.actorId,
      actor.actorId,
    ]);
    this.pending.delete(commandId);
    this.results.set(commandId, result);
    await this.audit.append(
      actor,
      'ACTION_APPLIED',
      pending.command.type,
      commandId,
      pending.command.targetId,
      {},
      now,
    );
    this.logger?.info('admin', LOG_EVENTS.ADMIN_ACTION_APPLIED, {
      commandId,
      metadata: {
        actionType: pending.command.type,
        status: result.status,
      },
    });
    return result;
  }

  /**
   * Создаёт отдельную compensation command, не изменяя исходную audit record.
   *
   * Freeze компенсируется unfreeze, emergency stop — resume. Policy/configuration
   * компенсируются только новой версией policy/rules через обычный dual-control flow.
   */
  async compensate(
    compensationId: string,
    originalCommandId: string,
    actor: AuditActor,
    now = new Date(),
  ): Promise<AdminResult> {
    const previous = this.results.get(compensationId);
    if (previous) return previous;
    const original = this.commands.get(originalCommandId);
    if (!original) throw new Error('Original administrative action does not exist');
    const reverseType = reverseAdminCommandType(original.type);
    const command = {
      commandId: compensationId,
      type: reverseType,
      targetId: original.targetId,
    } as AdminCommand;
    await this.assertRole(reverseType, actor, compensationId, original.targetId);
    await this.apply(command, actor, now, originalCommandId);
    this.commands.set(compensationId, command);
    const result = buildAdminResult(command, 'APPLIED', [actor.actorId]);
    this.results.set(compensationId, result);
    await this.audit.append(
      actor,
      'COMPENSATION_APPLIED',
      reverseType,
      compensationId,
      original.targetId,
      { originalCommandId },
      now,
    );
    return result;
  }

  /** Проверяет admission: frozen identity или circuit breaker запрещает новую заявку. */
  async canAdmit(userId: string, accountId: string, instrumentId: string): Promise<boolean> {
    try {
      await this.admission.assertAllowed({ userId, accountId, instrumentId });
      return true;
    } catch {
      return false;
    }
  }

  /** Возвращает fee policy, действующую в указанный момент времени. */
  getFeePolicyAt(at: Date): FeePolicy {
    return this.policies.getFeeAt(at);
  }
  /** Возвращает risk policy, действующую в указанный момент времени. */
  getRiskPolicyAt(at: Date): RiskPolicy {
    return this.policies.getRiskAt(at);
  }

  /** Строит reconciliation dashboard и фиксирует факт проверки в audit log. */
  async getDashboard(actor: AuditActor, now = new Date()): Promise<ReconciliationDashboard> {
    const records = await this.audit.getRecords();
    await this.assertRole('RECONCILIATION', actor, `reconcile-${records.length + 1}`, 'system');
    const controls = await this.admission.list();
    const dashboard = {
      auditIntegrity: await this.audit.verifyIntegrity(records),
      pendingApprovals: this.pending.size,
      frozenUsers: controls.filter(({ type, state }) => type === 'USER' && state === 'FROZEN')
        .length,
      frozenAccounts: controls.filter(({ type, state }) => type === 'ACCOUNT' && state === 'FROZEN')
        .length,
      stoppedTargets: controls
        .filter(
          ({ type, state }) =>
            (type === 'GLOBAL' || type === 'INSTRUMENT') &&
            (state === 'OPEN' || state === 'PAUSED'),
        )
        .map(({ targetId }) => targetId),
      instrumentStatuses: this.instruments.list().map((instrument) => ({
        instrumentId: instrument.id,
        status: instrument.status,
      })),
      feePolicyVersions: this.policies.listFeeVersions(),
      riskPolicyVersions: this.policies.listRiskVersions(),
    };
    if (!dashboard.auditIntegrity) this.metrics?.observeReconciliationDifference('ledger');
    await this.audit.append(
      actor,
      'RECONCILIATION_EXECUTED',
      'RECONCILIATION',
      `reconcile-${records.length + 1}`,
      'system',
      { auditIntegrity: dashboard.auditIntegrity },
      now,
    );
    return dashboard;
  }

  /**
   * Возвращает неизменяемую копию audit chain после проверки read-role.
   *
   * Авторизация остаётся в application boundary, а не только в контроллере:
   * это защищает журнал и при вызове сервиса из другого transport adapter.
   * Допускаются `ADMIN` и `AUDITOR`; support и risk manager не получают историю
   * действий, поскольку она может содержать служебные идентификаторы объектов.
   *
   * @example
   * `getAuditRecords({ actorId: 'auditor-1', role: 'AUDITOR' })` возвращает
   * записи в порядке их монотонного `sequence`, не раскрывая API-key secrets.
   */
  async getAuditRecords(actor: AuditActor): Promise<readonly AuditRecord[]> {
    if (actor.role !== 'ADMIN' && actor.role !== 'AUDITOR') {
      throw new ForbiddenException({
        code: 'AUDIT_READ_FORBIDDEN',
        message: 'Audit records access is forbidden',
      });
    }
    return this.audit.getRecords();
  }

  private async apply(
    command: AdminCommand,
    actor: AuditActor,
    effectiveAt: Date,
    compensationFor?: string,
  ): Promise<void> {
    switch (command.type) {
      case 'CONFIGURE_INSTRUMENT':
        if (command.rules) this.instruments.addRules(command.targetId, command.rules);
        else if (command.instrument) this.instruments.register(command.instrument);
        else throw new Error('Instrument or rules are required');
        break;
      case 'ACTIVATE_INSTRUMENT':
        this.instruments.setStatus(command.targetId, 'ACTIVE');
        await this.applyControl(command, actor, effectiveAt, 'ALLOW', compensationFor);
        break;
      case 'PAUSE_INSTRUMENT':
        this.instruments.setStatus(command.targetId, 'PAUSED');
        await this.applyControl(command, actor, effectiveAt, 'PAUSED', compensationFor);
        break;
      case 'CHANGE_FEE_POLICY':
        this.policies.appendFee(command.policy);
        break;
      case 'CHANGE_RISK_POLICY':
        this.policies.appendRisk(command.policy);
        break;
      case 'FREEZE_USER':
        this.frozenUsers.add(command.targetId);
        await this.applyControl(command, actor, effectiveAt, 'FROZEN', compensationFor);
        break;
      case 'UNFREEZE_USER':
        this.frozenUsers.delete(command.targetId);
        await this.applyControl(command, actor, effectiveAt, 'ALLOW', compensationFor);
        break;
      case 'FREEZE_ACCOUNT':
        this.frozenAccounts.add(command.targetId);
        await this.applyControl(command, actor, effectiveAt, 'FROZEN', compensationFor);
        break;
      case 'UNFREEZE_ACCOUNT':
        this.frozenAccounts.delete(command.targetId);
        await this.applyControl(command, actor, effectiveAt, 'ALLOW', compensationFor);
        break;
      case 'EMERGENCY_STOP':
        this.stoppedTargets.add(command.targetId);
        await this.applyControl(command, actor, effectiveAt, 'OPEN', compensationFor);
        this.metrics?.setCircuitBreaker('trading', 'open');
        break;
      case 'RESUME_TRADING':
        this.stoppedTargets.delete(command.targetId);
        await this.applyControl(command, actor, effectiveAt, 'ALLOW', compensationFor);
        this.metrics?.setCircuitBreaker('trading', 'closed');
        break;
    }
  }

  /** Маппит административную команду в общий durable control contract. */
  private applyControl(
    command: AdminCommand,
    actor: AuditActor,
    effectiveAt: Date,
    state: AdmissionControlChange['state'],
    compensationFor?: string,
  ): Promise<void> {
    const type: AdmissionControlChange['type'] = command.type.includes('USER')
      ? 'USER'
      : command.type.includes('ACCOUNT')
        ? 'ACCOUNT'
        : command.type.includes('INSTRUMENT')
          ? 'INSTRUMENT'
          : command.targetId === '*'
            ? 'GLOBAL'
            : 'INSTRUMENT';
    return this.admission.apply({
      commandId: command.commandId,
      type,
      targetId: type === 'GLOBAL' ? '*' : command.targetId,
      state,
      effectiveAt,
      actorId: actor.actorId,
      reasonCode: command.type,
      ...(compensationFor ? { compensationFor } : {}),
    });
  }

  private async assertRole(
    type: AdminCommand['type'] | 'RECONCILIATION',
    actor: AuditActor,
    commandId: string,
    targetId: string,
  ): Promise<void> {
    return assertAdminRole(type, actor, commandId, targetId, this.audit, this.logger);
  }
}
