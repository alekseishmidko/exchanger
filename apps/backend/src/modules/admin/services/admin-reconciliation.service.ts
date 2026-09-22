import { AuditLogPort } from '../../audit';
import { InstrumentCatalogService } from '../../trading/instruments';
import { MetricsService } from '../../observability';
import { AdmissionControlPort } from '../ports/admission-control.port';
import { AdminPolicyRegistry } from '../policies/admin-policy-registry.service';
import { ReconciliationDashboard } from '../types/admin.types';

/** Dependencies, необходимые для построения reconciliation dashboard. */
export type AdminReconciliationInput = Readonly<{
  audit: AuditLogPort;
  admission: AdmissionControlPort;
  instruments: InstrumentCatalogService;
  policies: AdminPolicyRegistry;
  pendingApprovals: number;
  metrics?: MetricsService;
}>;

/**
 * Сервис построения admin reconciliation dashboard.
 *
 * Dashboard агрегирует audit integrity, control-plane state, instrument
 * lifecycle и версии policies. Он не выполняет authorization и не пишет audit
 * record — это остаётся в `AdminService`, где известен actor и commandId.
 */
export class AdminReconciliationService {
  /** Собирает read-only dashboard из application ports без прямого SQL доступа. */
  async build(input: AdminReconciliationInput): Promise<ReconciliationDashboard> {
    const records = await input.audit.getRecords();
    const controls = await input.admission.list();
    const dashboard = {
      auditIntegrity: await input.audit.verifyIntegrity(records),
      pendingApprovals: input.pendingApprovals,
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
      instrumentStatuses: input.instruments.list().map((instrument) => ({
        instrumentId: instrument.id,
        status: instrument.status,
      })),
      feePolicyVersions: input.policies.listFeeVersions(),
      riskPolicyVersions: input.policies.listRiskVersions(),
    };
    if (!dashboard.auditIntegrity) input.metrics?.observeReconciliationDifference('ledger');
    return dashboard;
  }
}
