import { Inject, Injectable } from '@nestjs/common';
import { HEALTH_DEPENDENCIES, HealthDependency } from './health.tokens';

/** Безопасный ответ liveness без сведений об инфраструктуре. */
export type LivenessResponse = {
  readonly status: 'ok';
};

/** Безопасный агрегированный ответ readiness-проверки. */
export type ReadinessResponse = {
  readonly status: 'ok' | 'unavailable';
  readonly checks: Readonly<Record<string, 'ok' | 'failed'>>;
};

/** Выполняет независимые liveness и readiness проверки приложения. */
@Injectable()
export class HealthService {
  constructor(
    @Inject(HEALTH_DEPENDENCIES)
    private readonly dependencies: readonly HealthDependency[],
  ) {}

  /** Возвращает OK, не вызывая ни одной внешней зависимости. */
  getLiveness(): LivenessResponse {
    return { status: 'ok' };
  }

  /** Проверяет все зарегистрированные зависимости и скрывает тексты их ошибок. */
  async getReadiness(): Promise<ReadinessResponse> {
    const results = await Promise.all(
      this.dependencies.map(async (dependency) => {
        try {
          await dependency.check();
          return [dependency.name, 'ok'] as const;
        } catch {
          return [dependency.name, 'failed'] as const;
        }
      }),
    );
    const checks = Object.fromEntries(results) as Readonly<Record<string, 'ok' | 'failed'>>;
    const status = results.every(([, result]) => result === 'ok') ? 'ok' : 'unavailable';

    return { status, checks };
  }
}
