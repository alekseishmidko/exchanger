import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { AppModule } from '../../app.module';

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
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
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
