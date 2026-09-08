import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { configureSwagger } from './swagger';

describe('Swagger configuration', () => {
  it('does not publish documentation in production without an explicit opt-in', () => {
    const result = configureSwagger(
      {} as INestApplication,
      new ConfigService({ NODE_ENV: 'production' }),
    );

    expect(result).toEqual({ enabled: false, path: 'docs' });
  });
});
