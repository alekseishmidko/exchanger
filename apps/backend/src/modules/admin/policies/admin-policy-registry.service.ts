import { Injectable } from '@nestjs/common';
import { FeePolicy, RiskPolicy } from '../types/admin.types';

/**
 * Хранит и валидирует версионированные административные политики.
 *
 * Registry отвечает только за монотонность версий и выбор effective policy:
 * он не знает о HTTP, audit, dual-control или PostgreSQL. Такой разрез
 * позволяет позднее заменить in-memory массивы на durable repository, не меняя
 * orchestration-код `AdminService`.
 *
 * @example
 * После approval команды `CHANGE_FEE_POLICY` сервис вызывает
 * `appendFee(policy)`, а торговый путь получает действующую версию через
 * `getFeeAt(command.acceptedAt)`.
 */
@Injectable()
export class AdminPolicyRegistry {
  private readonly feePolicies: FeePolicy[] = [];
  private readonly riskPolicies: RiskPolicy[] = [];

  /** Добавляет fee policy, если версия уникальна, а effectiveAt строго растёт. */
  appendFee(policy: FeePolicy): void {
    this.assertFee(policy);
    this.appendPolicy(this.feePolicies, policy);
  }

  /** Добавляет risk policy и проверяет, что лимиты пригодны для admission. */
  appendRisk(policy: RiskPolicy): void {
    this.assertRisk(policy);
    this.appendPolicy(this.riskPolicies, policy);
  }

  /** Возвращает fee policy, действующую на указанную дату. */
  getFeeAt(at: Date): FeePolicy {
    return this.effective(this.feePolicies, at);
  }

  /** Возвращает risk policy, действующую на указанную дату. */
  getRiskAt(at: Date): RiskPolicy {
    return this.effective(this.riskPolicies, at);
  }

  /** Возвращает версии fee policies для reconciliation dashboard. */
  listFeeVersions(): readonly string[] {
    return this.feePolicies.map(({ version }) => version);
  }

  /** Возвращает версии risk policies для reconciliation dashboard. */
  listRiskVersions(): readonly string[] {
    return this.riskPolicies.map(({ version }) => version);
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
}
