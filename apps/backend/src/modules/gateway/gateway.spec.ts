import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { AppModule } from '../../app.module';
import { ApiKeyRegistry } from './gateway.auth';

/**
 * E2E-проверки внешнего Gateway-контракта.
 *
 * Тесты используют реальный Nest module и Fastify adapter, поэтому одновременно
 * проверяют wiring guard/pipe/controller и безопасный mapping в reference trading
 * core. Каждый запрос проходит тот же HTTP pipeline, что и локальный клиент.
 */
describe('Gateway command API', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ApiKeyRegistry)
      .useValue(
        new ApiKeyRegistry([
          { keyId: 'dev-key', role: 'trader', userId: 'dev-user' },
          { keyId: 'admin-key', role: 'admin', userId: 'admin-user' },
        ]),
      )
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await (
      app.getHttpAdapter().getInstance() as unknown as { ready: () => PromiseLike<unknown> }
    ).ready();
  });

  afterAll(async () => app.close());

  /** Базовый валидный decimal-string payload для place endpoint. */
  const order = {
    commandId: 'command-1',
    orderId: 'order-1',
    accountId: 'dev-user',
    instrumentId: 'BTC-USD',
    clientOrderId: 'client-1',
    side: 'BUY',
    orderType: 'LIMIT',
    quantity: '1.25',
    limitPrice: '100',
    timeInForce: 'GTC',
  };

  it('publishes a safe authentication endpoint for Swagger clients', async () => {
    const authenticated = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('x-api-key', 'dev-key')
      .expect(200)
      .expect({
        authenticated: true,
        authenticationScheme: 'API_KEY',
        subjectId: 'dev-user',
        role: 'trader',
      });

    expect(JSON.stringify(authenticated.body)).not.toContain('dev-key');
    await request(app.getHttpServer()).get('/api/v1/auth/me').expect(401);
  });

  /** Проверяет полный lifecycle API key без утечки secrets через list/revoke. */
  it('issues, lists, rotates and revokes an API key through admin-only endpoints', async () => {
    const issueBody = {
      commandId: 'issue-key-1',
      userId: 'managed-user',
      role: 'trader',
      label: 'manual-testing',
    };
    const first = await request(app.getHttpServer())
      .post('/api/v1/auth/api-keys')
      .set('x-api-key', 'admin-key')
      .set('idempotency-key', 'issue-key-idem-1')
      .send(issueBody)
      .expect(201);
    const retry = await request(app.getHttpServer())
      .post('/api/v1/auth/api-keys')
      .set('x-api-key', 'admin-key')
      .set('idempotency-key', 'issue-key-idem-1')
      .send(issueBody)
      .expect(201);
    expect(retry.body).toEqual(first.body);

    const issued = first.body as { apiKey: string; metadata: { keyId: string } };
    expect(issued.apiKey).toMatch(/^ex_/);
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('x-api-key', issued.apiKey)
      .expect(200)
      .expect(({ body }) => expect((body as { subjectId: string }).subjectId).toBe('managed-user'));

    const listed = await request(app.getHttpServer())
      .get('/api/v1/auth/api-keys')
      .set('x-api-key', 'admin-key')
      .expect(200);
    expect(JSON.stringify(listed.body)).not.toContain(issued.apiKey);
    expect(JSON.stringify(listed.body)).not.toContain('admin-key');
    const ownKeyId = (
      listed.body as { items: Array<{ keyId: string; userId: string }> }
    ).items.find(({ userId }) => userId === 'admin-user')?.keyId;
    await request(app.getHttpServer())
      .post(`/api/v1/auth/api-keys/${ownKeyId}/revoke`)
      .set('x-api-key', 'admin-key')
      .set('idempotency-key', 'self-revoke-idem')
      .send({ commandId: 'self-revoke-command' })
      .expect(403)
      .expect(({ body }) =>
        expect((body as { code: string }).code).toBe('API_KEY_SELF_MUTATION_FORBIDDEN'),
      );

    const rotated = await request(app.getHttpServer())
      .post(`/api/v1/auth/api-keys/${issued.metadata.keyId}/rotate`)
      .set('x-api-key', 'admin-key')
      .set('idempotency-key', 'rotate-key-idem-1')
      .send({ commandId: 'rotate-key-1' })
      .expect(201);
    const rotatedApiKey = (rotated.body as { apiKey: string }).apiKey;
    expect(rotatedApiKey).not.toBe(issued.apiKey);
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('x-api-key', issued.apiKey)
      .expect(401);
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('x-api-key', rotatedApiKey)
      .expect(200);

    await request(app.getHttpServer())
      .post(`/api/v1/auth/api-keys/${issued.metadata.keyId}/revoke`)
      .set('x-api-key', 'admin-key')
      .set('idempotency-key', 'revoke-key-idem-1')
      .send({ commandId: 'revoke-key-1' })
      .expect(201)
      .expect(({ body }) => expect((body as { status: string }).status).toBe('REVOKED'));
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('x-api-key', rotatedApiKey)
      .expect(401);

    await request(app.getHttpServer())
      .post('/api/v1/auth/api-keys')
      .set('x-api-key', 'dev-key')
      .set('idempotency-key', 'trader-issue-forbidden')
      .send(issueBody)
      .expect(403);
  });

  it('authenticates, validates and maps place command to trading core', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('x-api-key', 'dev-key')
      .set('idempotency-key', 'idem-1')
      .send(order)
      .expect(201)
      .expect({ commandId: 'command-1', orderId: 'client-1', status: 'ACCEPTED' });
  });

  it('rejects invalid auth, malformed payload and object access', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('idempotency-key', 'idem-2')
      .send(order)
      .expect(401)
      .expect({ code: 'AUTH_INVALID_API_KEY', message: 'Authentication failed' });

    await request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('x-api-key', 'dev-key')
      .set('idempotency-key', 'idem-3')
      .send({ ...order, quantity: 1.25 })
      .expect(400)
      .expect((response) =>
        expect((response.body as { code: string }).code).toBe('REQUEST_MALFORMED'),
      );

    await request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('x-api-key', 'dev-key')
      .set('idempotency-key', 'idem-4')
      .send({ ...order, accountId: 'other-user' })
      .expect(403)
      .expect((response) =>
        expect((response.body as { code: string }).code).toBe('AUTH_OBJECT_FORBIDDEN'),
      );
  });

  it('returns the same result for duplicate idempotency key and rejects changed payload', async () => {
    const server = app.getHttpServer();
    await request(server)
      .post('/api/v1/orders')
      .set('x-api-key', 'dev-key')
      .set('idempotency-key', 'idem-5')
      .send({ ...order, commandId: 'command-5' })
      .expect(201);
    await request(server)
      .post('/api/v1/orders')
      .set('x-api-key', 'dev-key')
      .set('idempotency-key', 'idem-5')
      .send({ ...order, commandId: 'command-5' })
      .expect(201);
    await request(server)
      .post('/api/v1/orders')
      .set('x-api-key', 'dev-key')
      .set('idempotency-key', 'idem-5')
      .send({ ...order, commandId: 'other-command' })
      .expect(409);
  });

  it('maps cancel command and requires idempotency header', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/orders/order-1/cancel')
      .set('x-api-key', 'dev-key')
      .send({
        commandId: 'cancel-1',
        orderId: 'order-1',
        accountId: 'dev-user',
        instrumentId: 'BTC-USD',
      })
      .expect(400)
      .expect((response) =>
        expect((response.body as { code: string }).code).toBe('IDEMPOTENCY_KEY_REQUIRED'),
      );

    await request(app.getHttpServer())
      .post('/api/v1/orders/order-1/cancel')
      .set('x-api-key', 'dev-key')
      .set('idempotency-key', 'cancel-idem-1')
      .send({
        commandId: 'cancel-1',
        orderId: 'order-1',
        accountId: 'dev-user',
        instrumentId: 'BTC-USD',
      })
      .expect(201)
      .expect({ commandId: 'cancel-1', orderId: 'order-1', status: 'CANCEL_ACCEPTED' });
  });

  it('enforces bounded pagination limits', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/orders?limit=1')
      .set('x-api-key', 'dev-key')
      .expect(200)
      .expect((response) => {
        const body = response.body as { items: readonly unknown[]; nextCursor: string | null };
        expect(body.items).toHaveLength(1);
        expect(body.nextCursor).toBe('1');
      });

    await request(app.getHttpServer())
      .get('/api/v1/orders?limit=101')
      .set('x-api-key', 'dev-key')
      .expect(400)
      .expect((response) =>
        expect((response.body as { code: string }).code).toBe('PAGINATION_INVALID'),
      );
  });
});
