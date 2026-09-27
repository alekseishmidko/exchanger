/**
 * HTTP guard human sessions.
 * Он извлекает credential из одного настроенного transport, делегирует live
 * authentication сервису и прикрепляет к request только безопасный principal.
 */
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { HumanPrincipal } from '../../identity/domain/identity.types';
import { HumanAuthService } from '../application/human-auth.service';
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
  /**
   * @param identity Live validation session и user securityVersion.
   * @param config Выбор cookie/bearer transport и изолированного test bypass.
   * @param logger Audit telemetry факта использования test bypass.
   */
  constructor(
    private readonly identity: HumanAuthService,
    private readonly config: ConfigService,
    @Optional() private readonly logger?: StructuredLogger,
  ) {}

  /** Устанавливает principal до controller; invalid credential завершает request единым 401. */
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

  /** Извлекает ровно один credential transport и не поддерживает неявный fallback. */
  private extractSessionToken(request: HumanAuthenticatedRequest): string | undefined {
    if (this.config.get('AUTH_TOKEN_TRANSPORT', 'cookie') === 'bearer') {
      const authorization = this.header(request, 'authorization');
      const match = authorization?.match(/^Bearer ([A-Za-z0-9_-]{32,256})$/);
      return match?.[1];
    }
    const cookie = this.header(request, 'cookie');
    const name = this.config.get<string>('AUTH_COOKIE_NAME', '__Host-exchange_session');
    return cookie
      ?.split(';')
      .map((item) => item.trim())
      .find((item) => item.startsWith(`${name}=`))
      ?.slice(name.length + 1);
  }

  /** Разрешает fixed test identity только в test+component profile и timing-safe проверяет token. */
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

  /** Нормализует Node/Fastify multi-value header до первого значения. */
  private header(request: HumanAuthenticatedRequest, name: string): string | undefined {
    const value = request.headers[name];
    return Array.isArray(value) ? value[0] : value;
  }
  /** Возвращает общую ошибку для missing, expired, revoked и malformed credentials. */
  private unauthorized(): UnauthorizedException {
    return new UnauthorizedException({
      code: 'AUTH_SESSION_INVALID',
      message: 'Authentication failed',
    });
  }
}
