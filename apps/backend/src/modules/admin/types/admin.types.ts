import { AuditActor, AuditRecord } from '../../audit';
import { Decimal } from '../../shared-kernel';
import { Instrument, InstrumentRules } from '../../trading/instruments';

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
      instrument?: Instrument;
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
  | Readonly<{ commandId: string; type: 'EMERGENCY_STOP' | 'RESUME_TRADING'; targetId: string }>
  | Readonly<{
      commandId: string;
      type: 'ACTIVATE_INSTRUMENT' | 'PAUSE_INSTRUMENT';
      targetId: string;
    }>;

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

/** Pending action хранит исходного инициатора, чтобы approval был независимым. */
export type PendingAdminAction = Readonly<{
  command: AdminCommand;
  requestedBy: AuditActor;
  requestedAt: Date;
}>;

/** Контекст чтения audit records после проверки роли. */
export type AdminAuditReadResult = Promise<readonly AuditRecord[]>;
