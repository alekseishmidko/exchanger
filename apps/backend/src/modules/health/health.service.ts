import { Inject, Injectable, Optional } from '@nestjs/common';
import { HEALTH_DEPENDENCIES, HealthDependency } from './health.tokens';
import {
  LOG_EVENTS,
  NOOP_OPERATIONAL_LOGGER,
  OperationalLogger,
  StructuredLogger,
} from '../observability';

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
  private readonly logger: OperationalLogger;

  constructor(
    @Inject(HEALTH_DEPENDENCIES)
    private readonly dependencies: readonly HealthDependency[],
    @Optional() @Inject(StructuredLogger) logger?: StructuredLogger,
  ) {
    this.logger = logger ?? NOOP_OPERATIONAL_LOGGER;
  }

  /** Возвращает OK, не вызывая ни одной внешней зависимости. */
  getLiveness(): LivenessResponse {
    this.logger.info('health', LOG_EVENTS.HEALTH_LIVE);
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
          this.logger.failure('health', LOG_EVENTS.HEALTH_DEPENDENCY_FAILED, {
            metadata: { dependency: dependency.name },
          });
          return [dependency.name, 'failed'] as const;
        }
      }),
    );
    const checks = Object.fromEntries(results) as Readonly<Record<string, 'ok' | 'failed'>>;
    const status = results.every(([, result]) => result === 'ok') ? 'ok' : 'unavailable';

    if (status === 'ok') {
      this.logger.info('health', LOG_EVENTS.HEALTH_READY, {
        metadata: { dependencyCount: results.length },
      });
    }

    return { status, checks };
  }
}
