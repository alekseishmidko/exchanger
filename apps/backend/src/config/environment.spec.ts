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
});
