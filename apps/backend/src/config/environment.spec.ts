import { validateEnvironment } from './environment';

describe('environment validation', () => {
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
});
