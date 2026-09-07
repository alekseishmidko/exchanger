import { ForbiddenException } from '@nestjs/common';
import { AdminService, FeePolicy, RiskPolicy } from './admin.service';
import { AuditActor, AuditLog } from '../audit';
import { Decimal } from '../shared-kernel';

/** Проверяет role matrix, dual control, immutable audit и operational controls. */
describe('AdminService', () => {
  const admin1: AuditActor = { actorId: 'admin-1', role: 'ADMIN' };
  const admin2: AuditActor = { actorId: 'admin-2', role: 'ADMIN' };
  const risk1: AuditActor = { actorId: 'risk-1', role: 'RISK_MANAGER' };
  const risk2: AuditActor = { actorId: 'risk-2', role: 'RISK_MANAGER' };
  const auditor: AuditActor = { actorId: 'auditor-1', role: 'AUDITOR' };
  const support: AuditActor = { actorId: 'support-1', role: 'SUPPORT' };

  let audit: AuditLog;
  let service: AdminService;

  beforeEach(() => {
    audit = new AuditLog();
    service = new AdminService(audit);
  });

  it('enforces role matrix and audits forbidden action', () => {
    expect(() =>
      service.request({ commandId: 'freeze-1', type: 'FREEZE_USER', targetId: 'user-1' }, support),
    ).toThrow(ForbiddenException);
    expect(audit.getRecords()).toEqual([
      expect.objectContaining({ eventType: 'ACTION_REJECTED', actionType: 'FREEZE_USER' }),
    ]);
  });

  it('freezes admission and reverses state only through compensation', () => {
    const first = service.request(
      { commandId: 'freeze-1', type: 'FREEZE_ACCOUNT', targetId: 'account-1' },
      risk1,
    );
    expect(first.status).toBe('APPLIED');
    expect(service.canAdmit('user-1', 'account-1', 'BTC-USD')).toBe(false);
    service.compensate('compensate-1', 'freeze-1', risk1);
    expect(service.canAdmit('user-1', 'account-1', 'BTC-USD')).toBe(true);
    expect(audit.getRecords().map(({ eventType }) => eventType)).toContain('COMPENSATION_APPLIED');
  });

  it('requires independent dual control for emergency stop and supports idempotent retry', () => {
    const command = { commandId: 'stop-1', type: 'EMERGENCY_STOP' as const, targetId: '*' };
    expect(service.request(command, admin1).status).toBe('PENDING_APPROVAL');
    expect(service.request(command, admin1).status).toBe('PENDING_APPROVAL');
    expect(() => service.approve('stop-1', admin1)).toThrow(ForbiddenException);
    expect(service.approve('stop-1', admin2).status).toBe('APPLIED');
    expect(service.approve('stop-1', admin2).status).toBe('APPLIED');
    expect(service.canAdmit('user-1', 'account-1', 'BTC-USD')).toBe(false);
  });

  it('selects fee and risk policy by effective time and validates monotonic versions', () => {
    const fee: FeePolicy = {
      version: 'fee-v1',
      effectiveAt: new Date('2026-01-01T00:00:00Z'),
      makerRate: Decimal.from('0.001'),
      takerRate: Decimal.from('0.002'),
    };
    const risk: RiskPolicy = {
      version: 'risk-v1',
      effectiveAt: new Date('2026-02-01T00:00:00Z'),
      maxOrderNotional: Decimal.from('100000'),
      maxOpenOrders: 100,
    };
    service.request(
      { commandId: 'fee-1', type: 'CHANGE_FEE_POLICY', targetId: 'global', policy: fee },
      admin1,
    );
    service.approve('fee-1', risk1);
    service.request(
      { commandId: 'risk-1', type: 'CHANGE_RISK_POLICY', targetId: 'global', policy: risk },
      risk1,
    );
    service.approve('risk-1', risk2);
    expect(service.getFeePolicyAt(new Date('2026-03-01T00:00:00Z')).version).toBe('fee-v1');
    expect(service.getRiskPolicyAt(new Date('2026-03-01T00:00:00Z')).version).toBe('risk-v1');
  });

  it('detects audit tampering and exposes reconciliation dashboard', () => {
    service.request({ commandId: 'freeze-1', type: 'FREEZE_USER', targetId: 'user-1' }, admin1);
    const records = audit.getRecords();
    expect(audit.verifyIntegrity(records)).toBe(true);
    const tampered = records.map((record, index) =>
      index === 0 ? { ...record, targetId: 'other-user' } : record,
    );
    expect(audit.verifyIntegrity(tampered)).toBe(false);
    expect(service.getDashboard(auditor)).toMatchObject({
      auditIntegrity: true,
      frozenUsers: 1,
      pendingApprovals: 0,
    });
  });
});
