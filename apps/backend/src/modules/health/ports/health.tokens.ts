/** Токен списка зависимостей, которые определяют готовность приложения. */
export const HEALTH_DEPENDENCIES = Symbol('HEALTH_DEPENDENCIES');

/** Контракт минимальной проверки критичной инфраструктурной зависимости. */
export interface HealthDependency {
  readonly name: string;
  /** Только critical dependency влияет на итоговый HTTP 503. */
  readonly critical?: boolean;
  check(): Promise<void>;
}
