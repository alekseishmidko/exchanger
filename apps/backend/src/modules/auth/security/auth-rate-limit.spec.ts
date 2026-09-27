import { ConfigService } from '@nestjs/config';
import { AuthRateLimit } from './auth-rate-limit';
import { HttpException } from '@nestjs/common';

/** Brute-force limiter возвращает один public code и не включает email/IP key. */
describe('AuthRateLimit', () => {
  it('rejects attempts beyond the configured fixed window', async () => {
    const limiter = new AuthRateLimit(
      new ConfigService({
        RUNTIME_PROFILE: 'component',
        AUTH_RATE_LIMIT: '2',
        AUTH_RATE_GLOBAL_LIMIT: '2',
        AUTH_RATE_WINDOW_MS: '1000',
      }),
    );
    await limiter.check(['digest-only'], 0);
    await limiter.check(['digest-only'], 1);
    try {
      await limiter.check(['digest-only'], 2);
      throw new Error('RATE_LIMIT_WAS_NOT_APPLIED');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getResponse()).toMatchObject({ code: 'AUTH_RATE_LIMITED' });
    }
    await expect(limiter.check(['digest-only'], 1001)).resolves.toBeUndefined();
  });
});
