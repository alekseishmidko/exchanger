import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { ApiKeyRegistry } from '../src/modules/gateway/gateway.auth';
import {
  GatewayCancelOrderCommand,
  GatewayCommandResult,
  GatewayPlaceOrderCommand,
  TRADING_COMMAND_PORT,
  TradingCommandPort,
} from '../src/modules/gateway/gateway.types';
import {
  ADMISSION_CONTROL_PORT,
  AdmissionControlPort,
} from '../src/modules/admin/admission-control.port';
import { MemoryAdmissionControl } from '../src/modules/admin/memory-admission-control';

/** Trading double с задержкой, чтобы concurrent idempotency race был воспроизводимым. */
class SlowTradingPort implements TradingCommandPort {
  readonly placeCommands: GatewayPlaceOrderCommand[] = [];
  readonly cancelCommands: GatewayCancelOrderCommand[] = [];

  async placeOrder(command: GatewayPlaceOrderCommand): Promise<GatewayCommandResult> {
    this.placeCommands.push(command);
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { commandId: command.commandId, orderId: command.clientOrderId, status: 'ACCEPTED' };
  }

  async cancelOrder(command: GatewayCancelOrderCommand): Promise<GatewayCommandResult> {
    this.cancelCommands.push(command);
    await Promise.resolve();
    return { commandId: command.commandId, orderId: command.orderId, status: 'CANCEL_ACCEPTED' };
  }

  /** Lookup в abuse tests не используется, но interface требует owner-safe метод. */
  async getOrder(): Promise<GatewayCommandResult | null> {
    await Promise.resolve();
    return null;
  }

  async listOrders(): Promise<
    Readonly<{ items: readonly GatewayCommandResult[]; nextCursor: null }>
  > {
    await Promise.resolve();
    return { items: [], nextCursor: null };
  }
}

const order = {
  commandId: 'abuse-place-1',
  orderId: 'abuse-order-1',
  accountId: 'user-1',
  instrumentId: 'BTC-USD',
  clientOrderId: 'abuse-client-1',
  side: 'BUY',
  orderType: 'LIMIT',
  quantity: '1',
  limitPrice: '100',
  timeInForce: 'GTC',
} as const;

describe('Adversarial races and abuse controls', () => {
  let app: NestFastifyApplication;
  let trading: SlowTradingPort;
  let admission: AdmissionControlPort;

  beforeAll(async () => {
    trading = new SlowTradingPort();
    admission = new MemoryAdmissionControl();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ApiKeyRegistry)
      .useValue(
        new ApiKeyRegistry([
          { keyId: 'user-1-key', role: 'trader', userId: 'user-1' },
          { keyId: 'user-2-key', role: 'trader', userId: 'user-2' },
          { keyId: 'admin-key', role: 'admin', userId: 'admin-1' },
        ]),
      )
      .overrideProvider(TRADING_COMMAND_PORT)
      .useValue(trading)
      .overrideProvider(ADMISSION_CONTROL_PORT)
      .useValue(admission)
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await (app.getHttpAdapter().getInstance() as unknown as { ready: () => Promise<void> }).ready();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it('serializes concurrent duplicate place requests and conflicts on reused payload', async () => {
    const first = request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('x-api-key', 'user-1-key')
      .set('idempotency-key', 'concurrent-duplicate-place')
      .send(order);
    const second = request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('x-api-key', 'user-1-key')
      .set('idempotency-key', 'concurrent-duplicate-place')
      .send(order);

    const [left, right] = await Promise.all([first, second]);
    expect(left.status).toBe(201);
    expect(right.status).toBe(201);
    expect(left.body).toEqual(right.body);
    expect(
      trading.placeCommands.filter((command) => command.commandId === order.commandId),
    ).toHaveLength(1);

    await request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('x-api-key', 'user-1-key')
      .set('idempotency-key', 'concurrent-duplicate-place')
      .send({ ...order, commandId: 'abuse-place-conflict', clientOrderId: 'another-client' })
      .expect(409)
      .expect(({ body }) => expect((body as { code: string }).code).toBe('IDEMPOTENCY_KEY_REUSED'));
  });

  it('blocks freeze-vs-place, pause-vs-admission and allows cancel retry without duplicate effect', async () => {
    await admission.apply({
      commandId: 'freeze-user-1',
      type: 'USER',
      targetId: 'user-1',
      state: 'FROZEN',
      effectiveAt: new Date(0),
      actorId: 'admin-1',
      reasonCode: 'ABUSE_TEST',
    });
    await request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('x-api-key', 'user-1-key')
      .set('idempotency-key', 'freeze-vs-place')
      .send({ ...order, commandId: 'freeze-vs-place' })
      .expect(409)
      .expect(({ body }) => expect((body as { code: string }).code).toBe('USER_FROZEN'));
    await admission.apply({
      commandId: 'unfreeze-user-1',
      type: 'USER',
      targetId: 'user-1',
      state: 'ALLOW',
      effectiveAt: new Date(0),
      actorId: 'admin-1',
      reasonCode: 'ABUSE_TEST',
      compensationFor: 'freeze-user-1',
    });
    await admission.apply({
      commandId: 'pause-btc-usd',
      type: 'INSTRUMENT',
      targetId: 'BTC-USD',
      state: 'PAUSED',
      effectiveAt: new Date(0),
      actorId: 'admin-1',
      reasonCode: 'ABUSE_TEST',
    });
    await request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('x-api-key', 'user-1-key')
      .set('idempotency-key', 'pause-vs-admission')
      .send({ ...order, commandId: 'pause-vs-admission' })
      .expect(409)
      .expect(({ body }) => expect((body as { code: string }).code).toBe('INSTRUMENT_PAUSED'));
    await admission.apply({
      commandId: 'resume-btc-usd',
      type: 'INSTRUMENT',
      targetId: 'BTC-USD',
      state: 'ALLOW',
      effectiveAt: new Date(0),
      actorId: 'admin-1',
      reasonCode: 'ABUSE_TEST',
      compensationFor: 'pause-btc-usd',
    });

    const cancel = {
      commandId: 'cancel-vs-match',
      orderId: 'abuse-client-1',
      accountId: 'user-1',
      instrumentId: 'BTC-USD',
    };
    const first = await request(app.getHttpServer())
      .post('/api/v1/orders/abuse-client-1/cancel')
      .set('x-api-key', 'user-1-key')
      .set('idempotency-key', 'cancel-vs-match')
      .send(cancel)
      .expect(201);
    const retry = await request(app.getHttpServer())
      .post('/api/v1/orders/abuse-client-1/cancel')
      .set('x-api-key', 'user-1-key')
      .set('idempotency-key', 'cancel-vs-match')
      .send(cancel)
      .expect(201);
    expect(retry.body).toEqual(first.body);
    expect(
      trading.cancelCommands.filter((command) => command.commandId === 'cancel-vs-match'),
    ).toHaveLength(1);
  });

  it('keeps authorization isolation and rate-limit errors safe under abuse', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('x-api-key', 'user-2-key')
      .set('idempotency-key', 'auth-isolation-user-2')
      .send({ ...order, commandId: 'foreign-account' })
      .expect(403)
      .expect(({ body }) => expect(JSON.stringify(body)).not.toContain('user-1-key'));

    let rateLimited = false;
    for (let index = 0; index < 70; index += 1) {
      const response = await request(app.getHttpServer())
        .get('/api/v1/orders')
        .set('x-api-key', 'admin-key');
      if (response.status === 429) {
        rateLimited = true;
        expect(response.body).toMatchObject({ code: 'RATE_LIMIT_EXCEEDED' });
        expect(JSON.stringify(response.body)).not.toContain('admin-key');
        break;
      }
    }
    expect(rateLimited).toBe(true);
  });
});
