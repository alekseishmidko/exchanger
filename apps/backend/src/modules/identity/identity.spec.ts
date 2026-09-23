import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { AppModule } from '../../app.module';
import { ConfigService } from '@nestjs/config';
import { MemoryRecoveryDelivery } from './infrastructure/recovery-delivery';

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

describe('User identity HTTP contract', () => {
  let app: NestFastifyApplication;
  let aliceId: string;
  let delivery: MemoryRecoveryDelivery;

  beforeAll(async () => {
    process.env['AUTH_TEST_BYPASS_ENABLED'] = 'true';
    process.env['AUTH_TEST_IDENTITY'] =
      '{"userId":"isolated-admin","roles":["ADMIN"],"scopes":["admin:*","trading:write"]}';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ConfigService)
      .useValue(
        new ConfigService({
          ...process.env,
          AUTH_TEST_BYPASS_ENABLED: 'true',
          AUTH_TEST_BYPASS_TOKEN: 'isolated-test-bypass-token-never-production-2026',
          AUTH_TEST_IDENTITY: process.env['AUTH_TEST_IDENTITY'],
          AUTH_RATE_LIMIT: '100',
        }),
      )
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    delivery = moduleRef.get(MemoryRecoveryDelivery);
    await app.init();
    await (
      app.getHttpAdapter().getInstance() as unknown as { ready(): PromiseLike<unknown> }
    ).ready();
  });
  afterAll(async () => {
    await app.close();
    process.env['AUTH_TEST_BYPASS_ENABLED'] = 'false';
    delete process.env['AUTH_TEST_IDENTITY'];
  });

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
    aliceId = registration.user.id;
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
    const known = await request(app.getHttpServer())
      .post('/api/v1/auth/password-reset/request')
      .send({ email: 'alice@example.test' })
      .expect(202);
    const unknown = await request(app.getHttpServer())
      .post('/api/v1/auth/password-reset/request')
      .send({ email: 'nobody@example.test' })
      .expect(202);
    expect(unknown.body).toEqual(known.body);
    expect(JSON.stringify(known.body)).not.toMatch(/token|alice/i);
  });

  it('consumes verification/reset tokens once and invalidates stale sessions', async () => {
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
    await request(app.getHttpServer())
      .post('/api/v1/auth/email-verification/confirm')
      .send({ token: verification?.token })
      .expect(400);

    const staleLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'alice@example.test', password: 'new-correct-horse-2026' })
      .expect(200);
    const stale = authenticationHeaders(staleLogin);
    await request(app.getHttpServer())
      .post('/api/v1/auth/password-reset/request')
      .send({ email: 'alice@example.test' })
      .expect(202);
    const reset = delivery.takeLast();
    expect(reset?.kind).toBe('PASSWORD_RESET');
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
    const one = authenticationHeaders(
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'alice@example.test', password: 'reset-correct-horse-2026' })
        .expect(200),
    );
    const two = authenticationHeaders(
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'alice@example.test', password: 'reset-correct-horse-2026' })
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
    const ordinary = authenticationHeaders(
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'alice@example.test', password: 'reset-correct-horse-2026' })
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
      .send({ reason: 'security incident' })
      .expect(201);
    const retry = await request(app.getHttpServer())
      .post(`/api/v1/admin/users/${aliceId}/sessions/revoke-all`)
      .set('x-test-auth-token', token)
      .set('idempotency-key', 'admin-revoke-all-1')
      .send({ reason: 'security incident' })
      .expect(201);
    expect(retry.body).toEqual(first.body);
  });
});
