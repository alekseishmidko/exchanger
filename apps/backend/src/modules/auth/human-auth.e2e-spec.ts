import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { AppModule } from '../../app.module';
import { ConfigService } from '@nestjs/config';
import { MemoryRecoveryDelivery } from '../identity/infrastructure/recovery-delivery';

/** Извлекает cookies и CSRF token без публикации opaque session в snapshots. */
function authenticationHeaders(response: request.Response): { cookie: string; csrf: string } {
  const setCookie = response.headers['set-cookie'] as unknown as string[];
  const cookie = setCookie.map((value) => value.split(';')[0]).join('; ');
  const csrf = setCookie
    .find((value) => value.startsWith('exchange_csrf='))
    ?.split(';')[0]
    ?.split('=')[1];
  if (!csrf) throw new Error('CSRF_COOKIE_MISSING');
  return { cookie, csrf };
}

describe('Human authentication HTTP contract', () => {
  let app: NestFastifyApplication;
  let delivery: MemoryRecoveryDelivery;
  const testIdentity =
    '{"userId":"isolated-admin","roles":["ADMIN"],"scopes":["admin:*","trading:write"]}';

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ConfigService)
      .useValue(
        new ConfigService({
          ...process.env,
          NODE_ENV: 'test',
          RUNTIME_PROFILE: 'component',
          AUTH_USER_STORE_ADAPTER: 'memory',
          AUTH_SESSION_STORE_ADAPTER: 'memory',
          AUTH_API_KEY_STORE_ADAPTER: 'memory',
          AUTH_TEST_BYPASS_ENABLED: 'true',
          AUTH_TEST_BYPASS_TOKEN: 'isolated-test-bypass-token-never-production-2026',
          AUTH_TEST_IDENTITY: testIdentity,
          AUTH_RATE_LIMIT: '100',
          AUTH_TOKEN_TRANSPORT: 'cookie',
          AUTH_COOKIE_NAME: 'exchange_session',
          AUTH_CSRF_COOKIE_NAME: 'exchange_csrf',
          AUTH_COOKIE_SECURE: 'false',
          AUTH_COOKIE_SAME_SITE: 'Strict',
          AUTH_SESSION_IDLE_TTL_SECONDS: '1800',
          AUTH_SESSION_ABSOLUTE_TTL_SECONDS: '604800',
          AUTH_MAX_SESSIONS_PER_USER: '10',
          AUTH_TOKEN_HASH_SECRET: 'human-auth-e2e-token-hash-secret-2026',
        }),
      )
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    delivery = moduleRef.get(MemoryRecoveryDelivery);
    await app.init();
    await (
      app.getHttpAdapter().getInstance() as unknown as { ready(): PromiseLike<unknown> }
    ).ready();
    // Supertest иначе сам открывает и закрывает один Node server для каждого
    // request. Fastify fixture должен слушать один порт до afterEach, чтобы
    // последовательные idempotent/replay запросы не попадали в close/relisten.
    await app.listen(0, '127.0.0.1');
  });
  afterEach(async () => {
    if (app) await app.close();
  });

  async function registerAlice(): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email: 'alice@example.test', password: 'correct-horse-2026', name: 'Alice' })
      .expect(201);
    return (response.body as { user: { id: string } }).user.id;
  }

  it('registers, normalizes email and never exposes credentials or internal roles', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email: '  Alice@Example.TEST ', password: 'correct-horse-2026', name: 'Alice' })
      .expect(201);
    const registration = response.body as {
      user: { id: string; email: string; name: string; emailVerified: boolean };
    };
    expect(registration.user).toMatchObject({
      email: 'alice@example.test',
      name: 'Alice',
      emailVerified: false,
    });
    expect(JSON.stringify(response.body)).not.toMatch(/password|token|hash|roles|redis/i);
    expect(String(response.headers['set-cookie'])).toMatch(/HttpOnly.*SameSite=Strict/);
    const auth = authenticationHeaders(response);
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Cookie', auth.cookie)
      .expect(200)
      .expect(({ body }) =>
        expect((body as { capabilities: string[] }).capabilities).toContain('profile:write'),
      );
  });

  it('uses case-insensitive login, CSRF and per-session revoke', async () => {
    await registerAlice();
    const login1 = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'ALICE@example.test', password: 'correct-horse-2026', deviceLabel: 'first' })
      .expect(200);
    const login2 = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'alice@example.test', password: 'correct-horse-2026', deviceLabel: 'second' })
      .expect(200);
    const first = authenticationHeaders(login1);
    const second = authenticationHeaders(login2);
    await request(app.getHttpServer())
      .patch('/api/v1/users/me')
      .set('Cookie', second.cookie)
      .send({ name: 'No CSRF' })
      .expect(403);
    const sessions = await request(app.getHttpServer())
      .get('/api/v1/users/me/sessions')
      .set('Cookie', second.cookie)
      .expect(200);
    const firstSessionId = (
      sessions.body as Array<{ sessionId: string; deviceLabel: string }>
    ).find((item) => item.deviceLabel === 'first')?.sessionId;
    expect(firstSessionId).toBeDefined();
    await request(app.getHttpServer())
      .delete(`/api/v1/users/me/sessions/${firstSessionId}`)
      .set('Cookie', second.cookie)
      .set('x-csrf-token', second.csrf)
      .expect(204);
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Cookie', first.cookie)
      .expect(401);
  });

  it('rotates identity after password change and rejects unknown self-service fields', async () => {
    await registerAlice();
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'alice@example.test', password: 'correct-horse-2026' })
      .expect(200);
    const old = authenticationHeaders(login);
    await request(app.getHttpServer())
      .patch('/api/v1/users/me')
      .set('Cookie', old.cookie)
      .set('x-csrf-token', old.csrf)
      .send({ name: 'Alice 2', roles: ['ADMIN'] })
      .expect(400);
    const changed = await request(app.getHttpServer())
      .post('/api/v1/users/me/password')
      .set('Cookie', old.cookie)
      .set('x-csrf-token', old.csrf)
      .send({
        currentPassword: 'correct-horse-2026',
        newPassword: 'new-correct-horse-2026',
        logoutOtherSessions: true,
      })
      .expect(201);
    expect(JSON.stringify(changed.body)).not.toContain('new-correct-horse-2026');
    await request(app.getHttpServer()).get('/api/v1/auth/me').set('Cookie', old.cookie).expect(401);
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'alice@example.test', password: 'new-correct-horse-2026' })
      .expect(200);
  });

  it('returns the same recovery response for known and unknown email', async () => {
    await registerAlice();
    const knownStarted = Date.now();
    const known = await request(app.getHttpServer())
      .post('/api/v1/auth/password-reset/request')
      .send({ email: 'alice@example.test' })
      .expect(202);
    const knownDuration = Date.now() - knownStarted;
    const unknownStarted = Date.now();
    const unknown = await request(app.getHttpServer())
      .post('/api/v1/auth/password-reset/request')
      .send({ email: 'nobody@example.test' })
      .expect(202);
    const unknownDuration = Date.now() - unknownStarted;
    expect(unknown.body).toEqual(known.body);
    expect(JSON.stringify(known.body)).not.toMatch(/token|alice/i);
    expect(Math.abs(knownDuration - unknownDuration)).toBeLessThan(150);
  });

  it('consumes verification/reset tokens once and invalidates stale sessions', async () => {
    await registerAlice();
    await request(app.getHttpServer())
      .post('/api/v1/auth/email-verification/request')
      .send({ email: 'alice@example.test' })
      .expect(202);
    const verification = delivery.takeLast();
    expect(verification?.kind).toBe('EMAIL_VERIFY');
    await request(app.getHttpServer())
      .post('/api/v1/auth/email-verification/confirm')
      .send({ token: verification?.token })
      .expect(204);
    const consumedVerification = await request(app.getHttpServer())
      .post('/api/v1/auth/email-verification/confirm')
      .send({ token: verification?.token });
    expect({
      status: consumedVerification.status,
      code: (consumedVerification.body as { code?: string }).code,
      message: (consumedVerification.body as { message?: string }).message,
    }).toEqual({
      status: 400,
      code: 'AUTH_CHALLENGE_INVALID',
      message: 'Challenge is invalid or expired',
    });

    const staleLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'alice@example.test', password: 'correct-horse-2026' })
      .expect(200);
    const stale = authenticationHeaders(staleLogin);
    await request(app.getHttpServer())
      .post('/api/v1/auth/password-reset/request')
      .send({ email: 'alice@example.test' })
      .expect(202);
    const superseded = delivery.takeLast();
    await request(app.getHttpServer())
      .post('/api/v1/auth/password-reset/request')
      .send({ email: 'alice@example.test' })
      .expect(202);
    const reset = delivery.takeLast();
    expect(reset?.kind).toBe('PASSWORD_RESET');
    await request(app.getHttpServer())
      .post('/api/v1/auth/password-reset/confirm')
      .send({ token: superseded?.token, newPassword: 'superseded-correct-horse-2026' })
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/v1/auth/password-reset/confirm')
      .send({ token: reset?.token, newPassword: 'reset-correct-horse-2026' })
      .expect(204);
    await request(app.getHttpServer())
      .post('/api/v1/auth/password-reset/confirm')
      .send({ token: reset?.token, newPassword: 'another-correct-horse-2026' })
      .expect(400);
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Cookie', stale.cookie)
      .expect(401);
  });

  it('supports logout and logout-all with CSRF and fixation-safe distinct sessions', async () => {
    await registerAlice();
    const one = authenticationHeaders(
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'alice@example.test', password: 'correct-horse-2026' })
        .expect(200),
    );
    const two = authenticationHeaders(
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'alice@example.test', password: 'correct-horse-2026' })
        .expect(200),
    );
    expect(one.cookie).not.toBe(two.cookie);
    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Cookie', one.cookie)
      .set('x-csrf-token', one.csrf)
      .expect(204);
    await request(app.getHttpServer()).get('/api/v1/auth/me').set('Cookie', one.cookie).expect(401);
    await request(app.getHttpServer())
      .post('/api/v1/auth/logout-all')
      .set('Cookie', two.cookie)
      .set('x-csrf-token', two.csrf)
      .expect(200);
    await request(app.getHttpServer()).get('/api/v1/auth/me').set('Cookie', two.cookie).expect(401);
  });

  it('rejects protected endpoints without human session', async () => {
    await request(app.getHttpServer()).get('/api/v1/auth/me').expect(401);
    await request(app.getHttpServer()).get('/api/v1/users/me/sessions').expect(401);
    await request(app.getHttpServer()).get('/api/v1/admin/users/user-1/sessions').expect(401);
  });

  it('allows only the preconfigured isolated test identity and audits admin revoke', async () => {
    const token = 'isolated-test-bypass-token-never-production-2026';
    const aliceId = await registerAlice();
    const ordinary = authenticationHeaders(
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'alice@example.test', password: 'correct-horse-2026' })
        .expect(200),
    );
    await request(app.getHttpServer())
      .get(`/api/v1/admin/users/${aliceId}/sessions`)
      .set('Cookie', ordinary.cookie)
      .expect(403);
    await request(app.getHttpServer())
      .get(`/api/v1/admin/users/${aliceId}/sessions`)
      .set('x-test-auth-token', 'wrong-test-token-that-is-long-enough')
      .expect(401);
    const sessions = await request(app.getHttpServer())
      .get(`/api/v1/admin/users/${aliceId}/sessions`)
      .set('x-test-auth-token', token)
      .expect(200);
    expect(JSON.stringify(sessions.body)).not.toMatch(/token|digest|redis/i);
    const first = await request(app.getHttpServer())
      .post(`/api/v1/admin/users/${aliceId}/sessions/revoke-all`)
      .set('x-test-auth-token', token)
      .set('idempotency-key', 'admin-revoke-all-1')
      .send({ reason: 'security_incident' })
      .expect(201);
    const retry = await request(app.getHttpServer())
      .post(`/api/v1/admin/users/${aliceId}/sessions/revoke-all`)
      .set('x-test-auth-token', token)
      .set('idempotency-key', 'admin-revoke-all-1')
      .send({ reason: 'security_incident' })
      .expect(201);
    expect(retry.body).toEqual(first.body);
  });
});
