import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { HumanAuthenticatedRequest } from './human-session.guard';

/**
 * Double-submit CSRF guard для cookie transport.
 * Server выдаёт производный от sessionId token в readable SameSite cookie;
 * unsafe request обязан повторить его в header. Bearer transport CSRF не требует.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}
  canActivate(context: ExecutionContext): boolean {
    if (this.config.get('AUTH_TOKEN_TRANSPORT', 'cookie') !== 'cookie') return true;
    const request = context
      .switchToHttp()
      .getRequest<HumanAuthenticatedRequest & { method: string }>();
    if (request.principal.kind === 'TEST_BYPASS') return true;
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return true;
    const expected = this.token(request.principal.sessionId);
    const supplied = this.header(request, 'x-csrf-token');
    if (!supplied || !this.equal(expected, supplied))
      throw new ForbiddenException({
        code: 'AUTH_CSRF_INVALID',
        message: 'CSRF validation failed',
      });
    return true;
  }
  token(sessionId: string): string {
    return createHmac('sha256', this.config.getOrThrow<string>('AUTH_TOKEN_HASH_SECRET'))
      .update(`csrf\u0000${sessionId}`)
      .digest('base64url');
  }
  private equal(left: string, right: string): boolean {
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  private header(request: HumanAuthenticatedRequest, name: string): string | undefined {
    const value = request.headers[name];
    return Array.isArray(value) ? value[0] : value;
  }
}
