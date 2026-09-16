/**
 * Профиль persistence-композиции, независимый от режима компиляции Node.js.
 *
 * `component` разрешает детерминированные in-memory adapters для локальных и
 * компонентных тестов. `staging` и `production` требуют durable-хранилища и
 * проходят одинаковые проверки запрета volatile state.
 */
export type RuntimeProfile = 'component' | 'staging' | 'production';

/**
 * Имена критичных boundary, состояние которых обязано переживать restart.
 *
 * Список является единым каталогом для validation и startup-сверки. Добавление
 * нового write boundary требует включить его сюда, описать допустимые adapters
 * и указать фактическую реализацию в composition root.
 */
export const DURABLE_ADAPTER_KEYS = [
  'COMMAND_STORE_ADAPTER',
  'LEDGER_STORE_ADAPTER',
  'EVENT_LOG_ADAPTER',
  'IDEMPOTENCY_STORE_ADAPTER',
  'AUDIT_STORE_ADAPTER',
  'SEQUENCER_STORE_ADAPTER',
  'PROJECTION_STORE_ADAPTER',
  'ADMISSION_CONTROL_ADAPTER',
] as const;

/**
 * Имя переменной окружения, выбирающей конкретный infrastructure adapter.
 * Тип выводится из каталога, поэтому validation не сможет забыть один из ключей.
 */
export type DurableAdapterKey = (typeof DURABLE_ADAPTER_KEYS)[number];

/**
 * Проверенные настройки critical write path, используемые composition root.
 *
 * Значения не содержат connection strings или credentials. Они только выбирают
 * зарегистрированный adapter; секреты подключения читаются самим infrastructure
 * provider через отдельные обязательные настройки.
 */
export type RuntimeAdapterConfiguration = Readonly<{
  RUNTIME_PROFILE: RuntimeProfile;
  COMMAND_STORE_ADAPTER: 'memory' | 'postgres';
  LEDGER_STORE_ADAPTER: 'memory' | 'postgres';
  EVENT_LOG_ADAPTER: 'memory' | 'postgres-outbox';
  IDEMPOTENCY_STORE_ADAPTER: 'memory' | 'postgres';
  AUDIT_STORE_ADAPTER: 'memory' | 'postgres';
  SEQUENCER_STORE_ADAPTER: 'memory' | 'postgres';
  PROJECTION_STORE_ADAPTER: 'memory' | 'postgres';
  ADMISSION_CONTROL_ADAPTER: 'memory' | 'postgres';
}>;

const allowedValues: Readonly<Record<DurableAdapterKey, readonly string[]>> = {
  COMMAND_STORE_ADAPTER: ['memory', 'postgres'],
  LEDGER_STORE_ADAPTER: ['memory', 'postgres'],
  EVENT_LOG_ADAPTER: ['memory', 'postgres-outbox'],
  IDEMPOTENCY_STORE_ADAPTER: ['memory', 'postgres'],
  AUDIT_STORE_ADAPTER: ['memory', 'postgres'],
  SEQUENCER_STORE_ADAPTER: ['memory', 'postgres'],
  PROJECTION_STORE_ADAPTER: ['memory', 'postgres'],
  ADMISSION_CONTROL_ADAPTER: ['memory', 'postgres'],
};

/**
 * Проверяет выбор persistence adapters до построения NestJS dependency graph.
 *
 * Профиль `component` является единственным профилем, которому разрешён
 * `memory`: он используется unit/component тестами и локальным reference
 * runtime. `staging` и `production` обязаны явно выбрать durable adapter для
 * каждого critical boundary. Отсутствующее значение не получает memory
 * fallback, поэтому ошибка деплоя обнаруживается до открытия сетевого порта.
 *
 * @example
 * ```ts
 * validateRuntimeAdapters({
 *   NODE_ENV: 'production',
 *   RUNTIME_PROFILE: 'production',
 *   COMMAND_STORE_ADAPTER: 'postgres',
 *   LEDGER_STORE_ADAPTER: 'postgres',
 *   EVENT_LOG_ADAPTER: 'postgres-outbox',
 *   IDEMPOTENCY_STORE_ADAPTER: 'postgres',
 *   AUDIT_STORE_ADAPTER: 'postgres',
 *   SEQUENCER_STORE_ADAPTER: 'postgres',
 *   PROJECTION_STORE_ADAPTER: 'postgres',
 *   ADMISSION_CONTROL_ADAPTER: 'postgres',
 * });
 * ```
 *
 * @param config Сырые переменные окружения без секретов подключения.
 * @returns Нормализованные значения, которые можно объединить с ConfigModule.
 * @throws Error Если профиль неизвестен, adapter не поддерживается или
 * production-like профиль пытается использовать volatile memory.
 */
export function validateRuntimeAdapters(
  config: Readonly<Record<string, unknown>>,
): RuntimeAdapterConfiguration {
  const defaultProfile: RuntimeProfile =
    config['NODE_ENV'] === 'production' ? 'production' : 'component';
  const profile = config['RUNTIME_PROFILE'] ?? defaultProfile;
  if (profile !== 'component' && profile !== 'staging' && profile !== 'production') {
    throw new Error('RUNTIME_PROFILE must be component, staging, or production');
  }
  if (config['NODE_ENV'] === 'production' && profile !== 'production') {
    throw new Error('NODE_ENV=production requires RUNTIME_PROFILE=production');
  }

  const normalized: Record<string, string> = { RUNTIME_PROFILE: profile };
  for (const key of DURABLE_ADAPTER_KEYS) {
    const value = config[key] ?? (profile === 'component' ? 'memory' : undefined);
    if (typeof value !== 'string' || !allowedValues[key].includes(value)) {
      throw new Error(`${key} must be one of: ${allowedValues[key].join(', ')}`);
    }
    if (profile !== 'component' && value === 'memory') {
      throw new Error(`${key}=memory is forbidden for ${profile} runtime`);
    }
    normalized[key] = value;
  }

  return normalized as RuntimeAdapterConfiguration;
}

/**
 * Сверяет заявленную конфигурацию с фактически подключённой композицией.
 *
 * Проверка нужна в переходный период: наличие значения `postgres` в env ещё не
 * означает, что NestJS provider действительно заменён. Несовпадение блокирует
 * startup и тем самым исключает тихий запуск production на reference adapter.
 *
 * @param configured Выбранные deployment-конфигурацией adapters.
 * @param composed Фактические adapters, зарегистрированные composition root.
 * @throws Error При первом несовпадении declared и actual adapter.
 */
export function assertRuntimeComposition(
  configured: RuntimeAdapterConfiguration,
  composed: Readonly<Record<DurableAdapterKey, string>>,
): void {
  for (const key of DURABLE_ADAPTER_KEYS) {
    if (configured[key] !== composed[key]) {
      throw new Error(
        `Runtime adapter mismatch for ${key}: configured=${configured[key]}, composed=${composed[key]}`,
      );
    }
  }
}
