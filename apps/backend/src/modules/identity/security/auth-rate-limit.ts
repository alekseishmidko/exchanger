import { HttpException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Component fixed-window brute-force limiter; production admission дополняется shared edge/Redis policy. */
@Injectable()
export class AuthRateLimit {
  private readonly windows = new Map<string, { startedAt: number; count: number }>();
  constructor(private readonly config: ConfigService) {}
  check(key: string, now = Date.now()): void {
    const limit = Number(this.config.get('AUTH_RATE_LIMIT', '10'));
    const duration = Number(this.config.get('AUTH_RATE_WINDOW_MS', '60000'));
    const previous = this.windows.get(key);
    const window =
      !previous || now - previous.startedAt >= duration ? { startedAt: now, count: 0 } : previous;
    window.count += 1;
    this.windows.set(key, window);
    if (window.count > limit)
      throw new HttpException(
        { code: 'AUTH_RATE_LIMITED', message: 'Request cannot be completed' },
        429,
      );
  }
}
