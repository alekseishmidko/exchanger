/** Токен списка зависимостей, которые определяют готовность приложения. */
export const HEALTH_DEPENDENCIES = Symbol('HEALTH_DEPENDENCIES');

/** Контракт минимальной проверки критичной инфраструктурной зависимости. */
export interface HealthDependency {
  readonly name: string;
  check(): Promise<void>;
}
