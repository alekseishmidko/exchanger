import type { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { IdentityService } from '../application/identity.service';
import { CsrfGuard } from './csrf.guard';
import { HumanSessionGuard } from './human-session.guard';

/** Transport isolation: guard читает credential только из выбранного механизма. */
describe('human auth transport isolation', () => {
  const principal = {
    kind: 'HUMAN_SESSION' as const,
    sessionId: 'session-1',
    userId: 'user-1',
    roles: ['USER'] as const,
    scopes: ['profile:read'],
    authLevel: 'PASSWORD' as const,
  };

  it('ignores cookies in bearer mode and authenticates only Authorization token', async () => {
    const authenticate = jest.fn().mockResolvedValue(principal);
    const config = new ConfigService({ AUTH_TOKEN_TRANSPORT: 'bearer' });
    const request = {
      method: 'POST',
      headers: {
        authorization: `Bearer ${'b'.repeat(48)}`,
        cookie: `exchange_session=${'c'.repeat(48)}`,
      },
    };
    const context = executionContext(request);
    const guard = new HumanSessionGuard({ authenticate } as unknown as IdentityService, config);
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(authenticate).toHaveBeenCalledWith('b'.repeat(48));
    expect(new CsrfGuard(config).canActivate(context)).toBe(true);
  });

  it('ignores Authorization header in cookie mode and enforces CSRF', async () => {
    const authenticate = jest.fn().mockResolvedValue(principal);
    const config = new ConfigService({
      AUTH_TOKEN_TRANSPORT: 'cookie',
      AUTH_COOKIE_NAME: 'exchange_session',
      AUTH_TOKEN_HASH_SECRET: 'token-secret-that-is-independent-2026',
    });
    const request = {
      method: 'POST',
      headers: {
        authorization: `Bearer ${'b'.repeat(48)}`,
        cookie: `exchange_session=${'c'.repeat(48)}`,
      },
    };
    const context = executionContext(request);
    const guard = new HumanSessionGuard({ authenticate } as unknown as IdentityService, config);
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(authenticate).toHaveBeenCalledWith('c'.repeat(48));
    expect(() => new CsrfGuard(config).canActivate(context)).toThrow('CSRF validation failed');
  });
});

function executionContext(request: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}
