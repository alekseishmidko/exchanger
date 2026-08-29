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
});
