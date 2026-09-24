import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { SessionIssueResult } from '../application/identity.service';
import { CsrfGuard } from './csrf.guard';

/** Минимальный response port для установки cookie без привязки к Fastify type. */
export type CookieResponse = { header(name: string, value: string | readonly string[]): void };

/**
 * Единая policy выдачи session credential для cookie и bearer transports.
 * Issue, rotation и clear используют одинаковые security attributes, поэтому
 * браузер принимает удаление `__Host-` cookie и не оставляет stale credential.
 */
@Injectable()
export class SessionCookieService {
  constructor(
    private readonly config: ConfigService,
    private readonly csrf: CsrfGuard,
  ) {}

  /** Выдаёт opaque token через выбранный transport без смешанных side effects. */
  set(response: CookieResponse, result: SessionIssueResult): void {
    if (this.config.get('AUTH_TOKEN_TRANSPORT', 'cookie') === 'bearer') {
      response.header('Authorization', `Bearer ${result.token}`);
      return;
    }
    const maxAge = Number(this.config.get('AUTH_SESSION_IDLE_TTL_SECONDS', '1800'));
    response.header('Set-Cookie', [
      this.serialize(this.sessionName(), result.token, maxAge, true),
      this.serialize(this.csrfName(), this.csrf.token(result.session.sessionId), maxAge, false),
    ]);
  }

  /** Удаляет cookies; bearer logout не создаёт cookie side effects. */
  clear(response: CookieResponse): void {
    if (this.config.get('AUTH_TOKEN_TRANSPORT', 'cookie') === 'bearer') return;
    response.header('Set-Cookie', [
      this.serialize(this.sessionName(), '', 0, true),
      this.serialize(this.csrfName(), '', 0, false),
    ]);
  }

  private serialize(name: string, value: string, maxAge: number, httpOnly: boolean): string {
    const secure = this.config.get('AUTH_COOKIE_SECURE', 'false') === 'true';
    const sameSite = this.config.get<string>('AUTH_COOKIE_SAME_SITE', 'Strict');
    return `${name}=${value}; Path=/; Max-Age=${maxAge}${httpOnly ? '; HttpOnly' : ''}; SameSite=${sameSite}${secure ? '; Secure' : ''}`;
  }
  private sessionName(): string {
    return this.config.get('AUTH_COOKIE_NAME', 'exchange_session');
  }
  private csrfName(): string {
    return this.config.get('AUTH_CSRF_COOKIE_NAME', 'exchange_csrf');
  }
}
