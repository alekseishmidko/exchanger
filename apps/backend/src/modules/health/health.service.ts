import { Inject, Injectable, Optional } from '@nestjs/common';
import { HEALTH_DEPENDENCIES, HealthDependency } from './health.tokens';
import {
  LOG_EVENTS,
  NOOP_OPERATIONAL_LOGGER,
  OperationalLogger,
  StructuredLogger,
} from '../observability';
import { ConfigService } from '@nestjs/config';

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
    private readonly config?: ConfigService,
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
          await this.withTimeout(
            dependency.check(),
            Number(this.config?.get('DEPENDENCY_PROBE_TIMEOUT_MS', '1000') ?? 1000),
          );
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
    const status = results.every(([, result], index) =>
      this.dependencies[index]?.critical === false ? true : result === 'ok',
    )
      ? 'ok'
      : 'unavailable';

    if (status === 'ok') {
      this.logger.info('health', LOG_EVENTS.HEALTH_READY, {
        metadata: { dependencyCount: results.length },
      });
    }

    return { status, checks };
  }

  /** Ограничивает probe deadline и не запускает retry storm при outage. */
  private withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('DEPENDENCY_PROBE_TIMEOUT')), timeoutMs);
      operation.then(
        (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timeout);
          reject(error instanceof Error ? error : new Error('DEPENDENCY_PROBE_FAILED'));
        },
      );
    });
  }
}
