import { ForbiddenException, Injectable } from '@nestjs/common';
import { AuditActor, AuditLog, AdministrativeRole } from '../audit';
import { Decimal } from '../shared-kernel';
import { Instrument, InstrumentRules } from '../trading/instruments';

/** Версионированная комиссия maker/taker, вступающая в силу в заданный момент. */
export type FeePolicy = Readonly<{
  version: string;
  effectiveAt: Date;
  makerRate: Decimal;
  takerRate: Decimal;
}>;
/** Версионированные risk limits, используемые admission policy. */
export type RiskPolicy = Readonly<{
  version: string;
  effectiveAt: Date;
  maxOrderNotional: Decimal;
  maxOpenOrders: number;
}>;

/** Все административные команды, допускаемые единственной write boundary. */
export type AdminCommand =
  | Readonly<{
      commandId: string;
      type: 'CONFIGURE_INSTRUMENT';
      targetId: string;
      instrument: Instrument;
      rules?: InstrumentRules;
    }>
  | Readonly<{ commandId: string; type: 'CHANGE_FEE_POLICY'; targetId: string; policy: FeePolicy }>
  | Readonly<{
      commandId: string;
      type: 'CHANGE_RISK_POLICY';
      targetId: string;
      policy: RiskPolicy;
    }>
  | Readonly<{
      commandId: string;
      type: 'FREEZE_USER' | 'UNFREEZE_USER' | 'FREEZE_ACCOUNT' | 'UNFREEZE_ACCOUNT';
      targetId: string;
    }>
  | Readonly<{ commandId: string; type: 'EMERGENCY_STOP' | 'RESUME_TRADING'; targetId: string }>;

/** Результат request/approval, безопасный для административного API. */
export type AdminResult = Readonly<{
  commandId: string;
  actionType: AdminCommand['type'];
  targetId: string;
  status: 'PENDING_APPROVAL' | 'APPLIED';
  approvedBy: readonly string[];
}>;

/** Сводка операционного состояния для reconciliation dashboard. */
export type ReconciliationDashboard = Readonly<{
  auditIntegrity: boolean;
  pendingApprovals: number;
  frozenUsers: number;
  frozenAccounts: number;
  stoppedTargets: readonly string[];
  instrumentStatuses: readonly Readonly<{ instrumentId: string; status: string }>[];
  feePolicyVersions: readonly string[];
  riskPolicyVersions: readonly string[];
}>;

type PendingAction = {
  readonly command: AdminCommand;
  readonly requestedBy: AuditActor;
  readonly requestedAt: Date;
};

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
  private readonly pending = new Map<string, PendingAction>();
  private readonly results = new Map<string, AdminResult>();
  private readonly commands = new Map<string, AdminCommand>();
  private readonly instruments = new Map<string, Instrument>();
  private readonly feePolicies: FeePolicy[] = [];
  private readonly riskPolicies: RiskPolicy[] = [];
  private readonly frozenUsers = new Set<string>();
  private readonly frozenAccounts = new Set<string>();
  private readonly stoppedTargets = new Set<string>();

  constructor(private readonly audit: AuditLog) {}

  /**
   * Запрашивает административное действие.
   *
   * Freeze/unfreeze применяется одним уполномоченным actor. Изменение инструмента,
   * fee/risk policy и emergency stop требуют dual control и возвращают
   * `PENDING_APPROVAL` до отдельного вызова `approve` другим сотрудником.
   */
  request(command: AdminCommand, actor: AuditActor, now = new Date()): AdminResult {
    const previous = this.results.get(command.commandId);
    if (previous) return previous;
    this.assertRole(command.type, actor, command.commandId, command.targetId);
    this.commands.set(command.commandId, command);
    this.audit.append(
      actor,
      'ACTION_REQUESTED',
      command.type,
      command.commandId,
      command.targetId,
      {},
      now,
    );
    if (this.requiresDualControl(command.type)) {
      const result = this.result(command, 'PENDING_APPROVAL', [actor.actorId]);
      this.pending.set(command.commandId, { command, requestedBy: actor, requestedAt: now });
      this.results.set(command.commandId, result);
      return result;
    }
    this.apply(command);
    const result = this.result(command, 'APPLIED', [actor.actorId]);
    this.results.set(command.commandId, result);
    this.audit.append(
      actor,
      'ACTION_APPLIED',
      command.type,
      command.commandId,
      command.targetId,
      {},
      now,
    );
    return result;
  }

  /**
   * Подтверждает pending action вторым независимым actor и применяет его один раз.
   *
   * @throws ForbiddenException Если approver совпадает с инициатором или его роль
   * не разрешает соответствующее действие.
   */
  approve(commandId: string, actor: AuditActor, now = new Date()): AdminResult {
    const current = this.results.get(commandId);
    if (current?.status === 'APPLIED') return current;
    const pending = this.pending.get(commandId);
    if (!pending) throw new Error('Pending administrative action does not exist');
    this.assertRole(pending.command.type, actor, commandId, pending.command.targetId);
    if (pending.requestedBy.actorId === actor.actorId)
      throw new ForbiddenException({
        code: 'DUAL_CONTROL_REQUIRED',
        message: 'Independent approval is required',
      });
    this.audit.append(
      actor,
      'ACTION_APPROVED',
      pending.command.type,
      commandId,
      pending.command.targetId,
      { requestedBy: pending.requestedBy.actorId },
      now,
    );
    this.apply(pending.command);
    const result = this.result(pending.command, 'APPLIED', [
      pending.requestedBy.actorId,
      actor.actorId,
    ]);
    this.pending.delete(commandId);
    this.results.set(commandId, result);
    this.audit.append(
      actor,
      'ACTION_APPLIED',
      pending.command.type,
      commandId,
      pending.command.targetId,
      {},
      now,
    );
    return result;
  }

  /**
   * Создаёт отдельную compensation command, не изменяя исходную audit record.
   *
   * Freeze компенсируется unfreeze, emergency stop — resume. Policy/configuration
   * компенсируются только новой версией policy/rules через обычный dual-control flow.
   */
  compensate(
    compensationId: string,
    originalCommandId: string,
    actor: AuditActor,
    now = new Date(),
  ): AdminResult {
    const previous = this.results.get(compensationId);
    if (previous) return previous;
    const original = this.commands.get(originalCommandId);
    if (!original) throw new Error('Original administrative action does not exist');
    const reverseType = this.reverseType(original.type);
    const command = {
      commandId: compensationId,
      type: reverseType,
      targetId: original.targetId,
    } as AdminCommand;
    this.assertRole(reverseType, actor, compensationId, original.targetId);
    this.apply(command);
    this.commands.set(compensationId, command);
    const result = this.result(command, 'APPLIED', [actor.actorId]);
    this.results.set(compensationId, result);
    this.audit.append(
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
  canAdmit(userId: string, accountId: string, instrumentId: string): boolean {
    return (
      !this.frozenUsers.has(userId) &&
      !this.frozenAccounts.has(accountId) &&
      !this.stoppedTargets.has('*') &&
      !this.stoppedTargets.has(instrumentId)
    );
  }

  /** Возвращает fee policy, действующую в указанный момент времени. */
  getFeePolicyAt(at: Date): FeePolicy {
    return this.effective(this.feePolicies, at);
  }
  /** Возвращает risk policy, действующую в указанный момент времени. */
  getRiskPolicyAt(at: Date): RiskPolicy {
    return this.effective(this.riskPolicies, at);
  }

  /** Строит reconciliation dashboard и фиксирует факт проверки в audit log. */
  getDashboard(actor: AuditActor, now = new Date()): ReconciliationDashboard {
    this.assertRole(
      'RECONCILIATION',
      actor,
      `reconcile-${this.audit.getRecords().length + 1}`,
      'system',
    );
    const dashboard = {
      auditIntegrity: this.audit.verifyIntegrity(),
      pendingApprovals: this.pending.size,
      frozenUsers: this.frozenUsers.size,
      frozenAccounts: this.frozenAccounts.size,
      stoppedTargets: [...this.stoppedTargets],
      instrumentStatuses: [...this.instruments.entries()].map(([instrumentId, instrument]) => ({
        instrumentId,
        status: instrument.getStatus(),
      })),
      feePolicyVersions: this.feePolicies.map(({ version }) => version),
      riskPolicyVersions: this.riskPolicies.map(({ version }) => version),
    };
    this.audit.append(
      actor,
      'RECONCILIATION_EXECUTED',
      'RECONCILIATION',
      `reconcile-${this.audit.getRecords().length + 1}`,
      'system',
      { auditIntegrity: dashboard.auditIntegrity },
      now,
    );
    return dashboard;
  }

  private apply(command: AdminCommand): void {
    switch (command.type) {
      case 'CONFIGURE_INSTRUMENT':
        if (command.rules) command.instrument.addRules(command.rules);
        else this.instruments.set(command.targetId, command.instrument);
        break;
      case 'CHANGE_FEE_POLICY':
        this.assertFee(command.policy);
        this.appendPolicy(this.feePolicies, command.policy);
        break;
      case 'CHANGE_RISK_POLICY':
        this.assertRisk(command.policy);
        this.appendPolicy(this.riskPolicies, command.policy);
        break;
      case 'FREEZE_USER':
        this.frozenUsers.add(command.targetId);
        break;
      case 'UNFREEZE_USER':
        this.frozenUsers.delete(command.targetId);
        break;
      case 'FREEZE_ACCOUNT':
        this.frozenAccounts.add(command.targetId);
        break;
      case 'UNFREEZE_ACCOUNT':
        this.frozenAccounts.delete(command.targetId);
        break;
      case 'EMERGENCY_STOP':
        this.stoppedTargets.add(command.targetId);
        break;
      case 'RESUME_TRADING':
        this.stoppedTargets.delete(command.targetId);
        break;
    }
  }

  private assertRole(
    type: AdminCommand['type'] | 'RECONCILIATION',
    actor: AuditActor,
    commandId: string,
    targetId: string,
  ): void {
    const allowed: Record<AdminCommand['type'] | 'RECONCILIATION', readonly AdministrativeRole[]> =
      {
        CONFIGURE_INSTRUMENT: ['ADMIN', 'RISK_MANAGER'],
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
    if (!allowed[type].includes(actor.role)) {
      this.audit.append(actor, 'ACTION_REJECTED', type, commandId, targetId, {
        reason: 'ROLE_FORBIDDEN',
      });
      throw new ForbiddenException({
        code: 'ADMIN_FORBIDDEN',
        message: 'Administrative action is forbidden',
      });
    }
  }

  private requiresDualControl(type: AdminCommand['type']): boolean {
    return [
      'CONFIGURE_INSTRUMENT',
      'CHANGE_FEE_POLICY',
      'CHANGE_RISK_POLICY',
      'EMERGENCY_STOP',
      'RESUME_TRADING',
    ].includes(type);
  }
  private result(
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
  private appendPolicy<T extends { version: string; effectiveAt: Date }>(
    policies: T[],
    policy: T,
  ): void {
    if (
      policy.version.trim() === '' ||
      policies.some(({ version }) => version === policy.version) ||
      (policies.at(-1)?.effectiveAt ?? new Date(0)) >= policy.effectiveAt
    )
      throw new Error('Policy version/effectiveAt must be unique and monotonic');
    policies.push(policy);
  }
  private assertRisk(policy: RiskPolicy): void {
    if (
      policy.maxOrderNotional.isNegative() ||
      policy.maxOrderNotional.isZero() ||
      !Number.isInteger(policy.maxOpenOrders) ||
      policy.maxOpenOrders < 1
    )
      throw new Error('Invalid risk policy');
  }

  private assertFee(policy: FeePolicy): void {
    if (policy.makerRate.isNegative() || policy.takerRate.isNegative()) {
      throw new Error('Invalid fee policy');
    }
  }
  private effective<T extends { effectiveAt: Date }>(policies: readonly T[], at: Date): T {
    const result = policies.filter(({ effectiveAt }) => effectiveAt <= at).at(-1);
    if (!result) throw new Error('No effective policy');
    return result;
  }
  private reverseType(type: AdminCommand['type']): AdminCommand['type'] {
    const reverse: Partial<Record<AdminCommand['type'], AdminCommand['type']>> = {
      FREEZE_USER: 'UNFREEZE_USER',
      UNFREEZE_USER: 'FREEZE_USER',
      FREEZE_ACCOUNT: 'UNFREEZE_ACCOUNT',
      UNFREEZE_ACCOUNT: 'FREEZE_ACCOUNT',
      EMERGENCY_STOP: 'RESUME_TRADING',
      RESUME_TRADING: 'EMERGENCY_STOP',
    };
    const result = reverse[type];
    if (!result) throw new Error('Action requires a new version instead of direct compensation');
    return result;
  }
}
