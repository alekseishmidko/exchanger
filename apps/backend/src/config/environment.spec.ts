import { environmentFilePaths, validateEnvironment } from './environment';

describe('environment validation', () => {
  const authSecrets = {
    AUTH_PASSWORD_PEPPER: 'password-pepper-that-is-long-enough-2026',
    AUTH_TOKEN_HASH_SECRET: 'token-secret-that-is-independent-2026',
    AUTH_DUMMY_PASSWORD_HASH:
      'scrypt$16384$8$1$ABEiM0RVZneImaq7zN3u_w$DZ1tZcbkavfuen6HDCxkh17VbrwawMLn9jfU1awYfAQ',
  } as const;
  /** Гарантирует, что clean-checkout tests получают безопасный test template. */
  it('uses an environment-specific example after the ignored runtime override', () => {
    expect(environmentFilePaths('/repo/apps/backend/src', 'test')).toEqual([
      '/repo/.env.test',
      '/repo/.env.test.example',
      '/repo/.env.example',
    ]);
  });
  it('rejects an invalid production configuration', () => {
    expect(() =>
      validateEnvironment({
        NODE_ENV: 'production',
        PORT: 'not-a-port',
        SERVICE_NAME: 'exchange-backend',
      }),
    ).toThrow('PORT must be an integer');
  });

  it('rejects a missing required service name', () => {
    expect(() => validateEnvironment({ NODE_ENV: 'development', PORT: '5000' })).toThrow(
      'SERVICE_NAME is required',
    );
  });

  it('rejects test bypass outside isolated test profile', () => {
    expect(() =>
      validateEnvironment({
        NODE_ENV: 'development',
        PORT: '5000',
        SERVICE_NAME: 'exchange-backend',
        ...authSecrets,
        AUTH_TEST_BYPASS_ENABLED: 'true',
        AUTH_TEST_BYPASS_TOKEN: 'isolated-test-token-that-is-long-enough',
      }),
    ).toThrow('AUTH test bypass is allowed only');
  });

  it('rejects production-like memory sessions before opening a port', () => {
    expect(() =>
      validateEnvironment({
        NODE_ENV: 'production',
        PORT: '5000',
        SERVICE_NAME: 'exchange-backend',
        RUNTIME_PROFILE: 'production',
        COMMAND_STORE_ADAPTER: 'postgres',
        LEDGER_STORE_ADAPTER: 'postgres',
        EVENT_LOG_ADAPTER: 'postgres-outbox',
        IDEMPOTENCY_STORE_ADAPTER: 'postgres',
        AUDIT_STORE_ADAPTER: 'postgres',
        SEQUENCER_STORE_ADAPTER: 'postgres',
        PROJECTION_STORE_ADAPTER: 'postgres',
        ADMISSION_CONTROL_ADAPTER: 'postgres',
        INSTANCE_ID: 'backend-1',
        POSTGRES_URL: 'postgres://user:pass@postgres/exchange',
        AUTH_USER_STORE_ADAPTER: 'postgres',
        AUTH_SESSION_STORE_ADAPTER: 'memory',
        ...authSecrets,
      }),
    ).toThrow('AUTH_SESSION_STORE_ADAPTER must be redis');
  });

  /** Production-like runtime не запускает durable adapters без connection URL. */
  it('requires PostgreSQL URL for a fully configured production runtime', () => {
    expect(() =>
      validateEnvironment({
        NODE_ENV: 'production',
        PORT: '5000',
        SERVICE_NAME: 'exchange-backend',
        RUNTIME_PROFILE: 'production',
        COMMAND_STORE_ADAPTER: 'postgres',
        LEDGER_STORE_ADAPTER: 'postgres',
        EVENT_LOG_ADAPTER: 'postgres-outbox',
        IDEMPOTENCY_STORE_ADAPTER: 'postgres',
        AUDIT_STORE_ADAPTER: 'postgres',
        SEQUENCER_STORE_ADAPTER: 'postgres',
        PROJECTION_STORE_ADAPTER: 'postgres',
        ADMISSION_CONTROL_ADAPTER: 'postgres',
        INSTANCE_ID: 'backend-1',
      }),
    ).toThrow('POSTGRES_URL is required for production-like runtime');
  });

  it('rejects an invalid Swagger flag', () => {
    expect(() =>
      validateEnvironment({
        NODE_ENV: 'development',
        PORT: '5000',
        SERVICE_NAME: 'exchange-backend',
        SWAGGER_ENABLED: 'sometimes',
      }),
    ).toThrow('SWAGGER_ENABLED must be true, false, 1, or 0');
  });

  it('rejects an unsafe Swagger path', () => {
    expect(() =>
      validateEnvironment({
        NODE_ENV: 'development',
        PORT: '5000',
        SERVICE_NAME: 'exchange-backend',
        SWAGGER_PATH: '../docs',
      }),
    ).toThrow('SWAGGER_PATH must be a safe relative URL path');
  });

  it('accepts isolated bearer transport and rejects unknown mixed modes', () => {
    expect(
      validateEnvironment({
        NODE_ENV: 'test',
        PORT: '5000',
        SERVICE_NAME: 'exchange-backend',
        AUTH_TOKEN_TRANSPORT: 'bearer',
        ...authSecrets,
      }).AUTH_TOKEN_TRANSPORT,
    ).toBe('bearer');
    expect(() =>
      validateEnvironment({
        NODE_ENV: 'test',
        PORT: '5000',
        SERVICE_NAME: 'exchange-backend',
        AUTH_TOKEN_TRANSPORT: 'cookie,bearer',
        ...authSecrets,
      }),
    ).toThrow('AUTH_TOKEN_TRANSPORT must be cookie or bearer');
  });

  it.each(['8192', '20000', '1048576'])('rejects unsafe scrypt cost %s', (cost) => {
    expect(() =>
      validateEnvironment({
        NODE_ENV: 'test',
        PORT: '5000',
        SERVICE_NAME: 'exchange-backend',
        AUTH_SCRYPT_COST: cost,
        ...authSecrets,
      }),
    ).toThrow('AUTH_SCRYPT_COST');
  });

  /** Не допускает вывода управляемой строки или небезопасной схемы в startup URL. */
  it.each(['localhost:5000', 'javascript:alert(1)', 'file:///tmp/docs'])(
    'rejects an unsafe public URL: %s',
    (publicUrl) => {
      expect(() =>
        validateEnvironment({
          NODE_ENV: 'development',
          PORT: '5000',
          SERVICE_NAME: 'exchange-backend',
          APPLICATION_PUBLIC_URL: publicUrl,
        }),
      ).toThrow('APPLICATION_PUBLIC_URL must be an absolute HTTP(S) URL');
    },
  );

  /**
   * Защищает bounded-buffer контракт WebSocket gateway: нулевое либо дробное
   * значение фактически отключило бы ограничение или сделало поведение очереди
   * неоднозначным.
   */
  it.each(['0', '-1', '1.5', 'many'])('rejects invalid WebSocket limits: %s', (value) => {
    expect(() =>
      validateEnvironment({
        NODE_ENV: 'development',
        PORT: '5000',
        SERVICE_NAME: 'exchange-backend',
        WEBSOCKET_MAX_PENDING: value,
      }),
    ).toThrow('WEBSOCKET_MAX_PENDING must be a positive integer');
  });

  /** Не позволяет случайно открыть WebSocket для любого Origin пустой настройкой. */
  it('rejects an empty WebSocket origin allow-list', () => {
    expect(() =>
      validateEnvironment({
        NODE_ENV: 'production',
        PORT: '5000',
        SERVICE_NAME: 'exchange-backend',
        WEBSOCKET_ALLOWED_ORIGINS: '   ',
      }),
    ).toThrow('WEBSOCKET_ALLOWED_ORIGINS must be a non-empty comma-separated list');
  });

  /** Защищает logger от отключения sampling или бесконечно короткого окна. */
  it.each([
    ['LOG_SAMPLE_LIMIT', '0'],
    ['LOG_SAMPLE_WINDOW_MS', 'not-a-number'],
  ])('rejects invalid logging setting %s=%s', (key, value) => {
    expect(() =>
      validateEnvironment({
        NODE_ENV: 'production',
        PORT: '5000',
        SERVICE_NAME: 'exchange-backend',
        [key]: value,
      }),
    ).toThrow(`${key} must be a positive integer`);
  });

  /** Worker policy не может иметь нулевой batch/timeout, иначе recovery зависнет. */
  it.each([
    ['WORKERS_ENABLED', 'maybe', 'WORKERS_ENABLED must be true, false, 1, or 0'],
    ['WORKER_BATCH_SIZE', '0', 'WORKER_BATCH_SIZE must be a positive integer'],
    ['WORKER_TIMEOUT_MS', 'forever', 'WORKER_TIMEOUT_MS must be a positive integer'],
  ])('rejects invalid worker setting %s=%s', (key, value, message) => {
    expect(() =>
      validateEnvironment({
        NODE_ENV: 'development',
        PORT: '5000',
        SERVICE_NAME: 'exchange-backend',
        [key]: value,
      }),
    ).toThrow(message);
  });
});
