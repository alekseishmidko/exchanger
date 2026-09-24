import { ConfigService } from '@nestjs/config';
import { CsrfGuard } from './csrf.guard';
import { SessionCookieService } from './session-cookie.service';

/** Cookie regression: issue и clear сохраняют идентичные production attributes. */
describe('SessionCookieService', () => {
  it('clears __Host cookies with Secure, SameSite and Path attributes', () => {
    const config = new ConfigService({
      AUTH_COOKIE_NAME: '__Host-exchange_session',
      AUTH_CSRF_COOKIE_NAME: '__Host-exchange_csrf',
      AUTH_COOKIE_SECURE: 'true',
      AUTH_COOKIE_SAME_SITE: 'Strict',
      AUTH_TOKEN_HASH_SECRET: 'token-secret-that-is-independent-2026',
    });
    const service = new SessionCookieService(config, new CsrfGuard(config));
    let header: string | readonly string[] = '';
    service.clear({ header: (_name, value) => (header = value) });
    expect(header).toEqual([
      expect.stringContaining(
        '__Host-exchange_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict; Secure',
      ),
      expect.stringContaining('__Host-exchange_csrf=; Path=/; Max-Age=0; SameSite=Strict; Secure'),
    ]);
  });

  it('uses only Authorization response header in bearer mode', () => {
    const config = new ConfigService({
      AUTH_TOKEN_TRANSPORT: 'bearer',
      AUTH_TOKEN_HASH_SECRET: 'token-secret-that-is-independent-2026',
    });
    const service = new SessionCookieService(config, new CsrfGuard(config));
    const headers = new Map<string, string | readonly string[]>();
    service.set(
      { header: (name, value) => headers.set(name, value) },
      {
        token: 'opaque-session-token-with-more-than-32-characters',
        user: {
          id: 'user-1',
          email: 'safe@example.test',
          name: 'Safe User',
          emailVerified: false,
          createdAt: '2026-09-25T00:00:00.000Z',
        },
        session: {
          sessionId: 'session-1',
          current: true,
          createdAt: '2026-09-25T00:00:00.000Z',
          lastSeenAt: '2026-09-25T00:00:00.000Z',
          expiresAt: '2026-09-25T00:30:00.000Z',
          revokedAt: null,
          deviceLabel: 'test',
        },
      },
    );
    expect(headers.get('Authorization')).toBe(
      'Bearer opaque-session-token-with-more-than-32-characters',
    );
    expect(headers.has('Set-Cookie')).toBe(false);
    service.clear({ header: (name, value) => headers.set(name, value) });
    expect(headers.has('Set-Cookie')).toBe(false);
  });
});
