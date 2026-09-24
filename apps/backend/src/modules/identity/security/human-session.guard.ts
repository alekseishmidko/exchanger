import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { HumanPrincipal } from '../domain/identity.types';
import { IdentityService } from '../application/identity.service';
import { LOG_EVENTS, StructuredLogger } from '../../observability';

/** Request shape после session/test authentication. */
export type HumanAuthenticatedRequest = {
  headers: Record<string, string | string[] | undefined>;
  principal: HumanPrincipal;
  ip?: string;
};

/**
 * Guard разделяет production session auth и явный test bypass.
 * Test header компилируется как код, но активируется только при NODE_ENV=test,
 * component profile и двух явных secret-настройках. Header не принимает userId,
 * role или account: identity целиком берётся из allow-listed JSON configuration.
 */
@Injectable()
export class HumanSessionGuard implements CanActivate {
  constructor(
    private readonly identity: IdentityService,
    private readonly config: ConfigService,
    @Optional() private readonly logger?: StructuredLogger,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<HumanAuthenticatedRequest>();
    const testToken = this.header(request, 'x-test-auth-token');
    if (testToken) {
      request.principal = this.testPrincipal(testToken);
      this.logger?.info('identity', LOG_EVENTS.AUTH_TEST_BYPASS_USED, {
        metadata: { profile: 'isolated-test' },
      });
      return true;
    }
    request.principal = await this.identity.authenticate(this.extractSessionToken(request));
    return true;
  }

  private extractSessionToken(request: HumanAuthenticatedRequest): string | undefined {
    const authorization = this.header(request, 'authorization');
    if (authorization?.startsWith('Bearer ')) return authorization.slice(7);
    const cookie = this.header(request, 'cookie');
    const name = this.config.get<string>('AUTH_COOKIE_NAME', '__Host-exchange_session');
    return cookie
      ?.split(';')
      .map((item) => item.trim())
      .find((item) => item.startsWith(`${name}=`))
      ?.slice(name.length + 1);
  }

  private testPrincipal(token: string): HumanPrincipal {
    const enabled = this.config.get('AUTH_TEST_BYPASS_ENABLED', 'false') === 'true';
    if (
      this.config.get('NODE_ENV') !== 'test' ||
      this.config.get('RUNTIME_PROFILE') !== 'component' ||
      !enabled
    )
      throw this.unauthorized();
    const expected = createHmac('sha256', this.config.getOrThrow<string>('AUTH_TOKEN_HASH_SECRET'))
      .update(this.config.getOrThrow<string>('AUTH_TEST_BYPASS_TOKEN'))
      .digest();
    const supplied = createHmac('sha256', this.config.getOrThrow<string>('AUTH_TOKEN_HASH_SECRET'))
      .update(token)
      .digest();
    if (!timingSafeEqual(expected, supplied)) throw this.unauthorized();
    const configured = JSON.parse(
      this.config.get(
        'AUTH_TEST_IDENTITY',
        '{"userId":"test-user","roles":["USER"],"scopes":["profile:read","profile:write","trading:write"]}',
      ),
    ) as { userId: string; roles: HumanPrincipal['roles']; scopes: string[] };
    return {
      kind: 'TEST_BYPASS',
      sessionId: 'test-bypass',
      userId: configured.userId,
      roles: configured.roles,
      scopes: configured.scopes,
      authLevel: 'PASSWORD',
    };
  }

  private header(request: HumanAuthenticatedRequest, name: string): string | undefined {
    const value = request.headers[name];
    return Array.isArray(value) ? value[0] : value;
  }
  private unauthorized(): UnauthorizedException {
    return new UnauthorizedException({
      code: 'AUTH_SESSION_INVALID',
      message: 'Authentication failed',
    });
  }
}
