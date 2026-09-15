import { assertRuntimeComposition, validateRuntimeAdapters } from './runtime-adapters';

describe('runtime adapter safety', () => {
  /** Unit/component profile получает только явную volatile reference composition. */
  it('normalizes component adapters to memory', () => {
    expect(validateRuntimeAdapters({ NODE_ENV: 'test' })).toMatchObject({
      RUNTIME_PROFILE: 'component',
      COMMAND_STORE_ADAPTER: 'memory',
      LEDGER_STORE_ADAPTER: 'memory',
      EVENT_LOG_ADAPTER: 'memory',
      IDEMPOTENCY_STORE_ADAPTER: 'memory',
      AUDIT_STORE_ADAPTER: 'memory',
    });
  });

  /** Production не получает опасный memory fallback при пропущенной переменной. */
  it('blocks a production profile with missing durable adapters', () => {
    expect(() =>
      validateRuntimeAdapters({ NODE_ENV: 'production', RUNTIME_PROFILE: 'production' }),
    ).toThrow('COMMAND_STORE_ADAPTER must be one of');
  });

  /** Не позволяет обойти production guard подменой имени runtime profile. */
  it('blocks a component profile when NODE_ENV is production', () => {
    expect(() =>
      validateRuntimeAdapters({ NODE_ENV: 'production', RUNTIME_PROFILE: 'component' }),
    ).toThrow('NODE_ENV=production requires RUNTIME_PROFILE=production');
  });

  /** Staging считается production-like даже при NODE_ENV=development. */
  it('blocks an explicit in-memory adapter in staging', () => {
    expect(() =>
      validateRuntimeAdapters({
        NODE_ENV: 'development',
        RUNTIME_PROFILE: 'staging',
        COMMAND_STORE_ADAPTER: 'memory',
      }),
    ).toThrow('COMMAND_STORE_ADAPTER=memory is forbidden for staging runtime');
  });

  /**
   * Доказывает второй барьер: корректный durable env не может скрыть тот факт,
   * что composition root всё ещё зарегистрировал reference provider.
   */
  it('blocks declared durable configuration when the composed adapter is memory', () => {
    const configured = validateRuntimeAdapters({
      NODE_ENV: 'production',
      RUNTIME_PROFILE: 'production',
      COMMAND_STORE_ADAPTER: 'postgres',
      LEDGER_STORE_ADAPTER: 'postgres',
      EVENT_LOG_ADAPTER: 'postgres-outbox',
      IDEMPOTENCY_STORE_ADAPTER: 'postgres',
      AUDIT_STORE_ADAPTER: 'postgres',
    });
    expect(() =>
      assertRuntimeComposition(configured, {
        COMMAND_STORE_ADAPTER: 'memory',
        LEDGER_STORE_ADAPTER: 'memory',
        EVENT_LOG_ADAPTER: 'memory',
        IDEMPOTENCY_STORE_ADAPTER: 'memory',
        AUDIT_STORE_ADAPTER: 'memory',
      }),
    ).toThrow('Runtime adapter mismatch for COMMAND_STORE_ADAPTER');
  });
});
