import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { io, Socket } from 'socket.io-client';
import fc from 'fast-check';
import { AppModule } from '../src/app.module';
import { ApiKeyRegistry } from '../src/modules/gateway/gateway.auth';

type ErrorBody = { code?: string; statusCode?: number; message?: string };
type WsEnvelope = Readonly<{
  correlationId: string;
  sequence: number;
  data: { code?: string; [key: string]: unknown };
}>;
interface ServerEvents {
  [event: string]: (payload: WsEnvelope) => void;
}
interface ClientEvents {
  [event: string]: (payload: unknown) => void;
}
type MarketDataClient = Socket<ServerEvents, ClientEvents>;

const validPlaceOrder = {
  commandId: 'adv-command-1',
  orderId: 'adv-order-1',
  accountId: 'account-1',
  instrumentId: 'BTC-USD',
  clientOrderId: 'adv-client-1',
  side: 'BUY',
  orderType: 'LIMIT',
  quantity: '1',
  limitPrice: '100',
  timeInForce: 'GTC',
} as const;

/** Ожидает WebSocket protocol error и завершает тест timeout-ом вместо зависания. */
function nextError(socket: MarketDataClient): Promise<WsEnvelope> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for market.error')), 2000);
    socket.once('market.error', (payload) => {
      clearTimeout(timeout);
      resolve(payload);
    });
  });
}

/** Дожидается Socket.IO connection для fuzz-запросов namespace `/market-data`. */
function connect(socket: MarketDataClient): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('WebSocket connection timeout')), 2000);
    socket.once('connect', () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.once('connect_error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    socket.connect();
  });
}

describe('Adversarial inputs and protocol boundaries', () => {
  let app: NestFastifyApplication;
  let endpoint: string;
  const sockets: MarketDataClient[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ApiKeyRegistry)
      .useValue(
        new ApiKeyRegistry([
          { keyId: 'trader-key', role: 'trader', userId: 'user-1' },
          { keyId: 'admin-key', role: 'admin', userId: 'admin-1' },
        ]),
      )
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ bodyLimit: 1024 }),
    );
    await app.listen(0, '127.0.0.1');
    endpoint = `${await app.getUrl()}/market-data`;
  });

  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.disconnect();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  /** Отправляет raw JSON, минуя `.send(object)`, чтобы проверить parser boundary. */
  function postRaw(body: string): request.Test {
    return request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('x-api-key', 'trader-key')
      .set('idempotency-key', `adv-${Math.random().toString(36).slice(2)}`)
      .set('content-type', 'application/json')
      .send(body);
  }

  it('rejects empty, oversized, deeply nested, truncated and malformed JSON without 500', async () => {
    const cases = [
      '',
      'null',
      '{"commandId":"truncated"',
      '{not-json}',
      JSON.stringify({ nested: Array.from({ length: 40 }).reduce((value) => [value], 'x') }),
      JSON.stringify({ ...validPlaceOrder, padding: 'x'.repeat(2048) }),
    ];

    for (const body of cases) {
      const response = await postRaw(body);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
      expect(JSON.stringify(response.body)).not.toContain('trader-key');
    }
  });

  it('rejects Unicode-confusable, control character and duplicate-key identifiers safely', async () => {
    for (const orderId of ['order\u0000', 'order\n1', 'оrder-1']) {
      const response = await request(app.getHttpServer())
        .post('/api/v1/orders')
        .set('x-api-key', 'trader-key')
        .set('idempotency-key', `identifier-${Buffer.from(orderId).toString('hex').slice(0, 16)}`)
        .send({ ...validPlaceOrder, commandId: `cmd-${Date.now()}`, orderId });
      expect(response.status).toBe(400);
      expect((response.body as ErrorBody).code).toBe('REQUEST_MALFORMED');
    }

    const duplicateKeyBody =
      '{"commandId":"dup-command","commandId":0,"orderId":"dup-order","accountId":"account-1","instrumentId":"BTC-USD","clientOrderId":"client-1","side":"BUY","orderType":"LIMIT","quantity":"1","limitPrice":"100","timeInForce":"GTC"}';
    const duplicateKey = await postRaw(duplicateKeyBody);
    expect(duplicateKey.status).toBe(400);
    expect((duplicateKey.body as ErrorBody).code).toBe('REQUEST_MALFORMED');
  });

  it('rejects adversarial decimal strings on the command boundary', async () => {
    for (const quantity of ['00', '01.00', '1e3', 'NaN', 'Infinity']) {
      const response = await request(app.getHttpServer())
        .post('/api/v1/orders')
        .set('x-api-key', 'trader-key')
        .set('idempotency-key', `decimal-${quantity.replace(/[^A-Za-z0-9]/g, '-')}`)
        .send({ ...validPlaceOrder, commandId: `cmd-${quantity}`, quantity });
      expect(response.status).toBe(400);
      expect((response.body as ErrorBody).code).toBe('REQUEST_MALFORMED');
    }
  });

  it('uses seeded REST fuzzing without uncaught exception or process crash', async () => {
    let run = 0;
    await fc.assert(
      fc.asyncProperty(fc.jsonValue(), async (payload) => {
        const response = await request(app.getHttpServer())
          .post('/api/v1/orders')
          .set('x-api-key', 'trader-key')
          .set('idempotency-key', `fuzz-${run++}`)
          .send({ fuzz: payload });
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(response.status).toBeLessThan(500);
        expect(JSON.stringify(response.body)).not.toContain('trader-key');
      }),
      { seed: 18_002, numRuns: 32 },
    );
  });

  it('handles WebSocket protocol fuzzing and unknown event types without crashing', async () => {
    const socket = io(endpoint, {
      autoConnect: false,
      transports: ['websocket'],
      reconnection: false,
    }) as MarketDataClient;
    sockets.push(socket);
    await connect(socket);

    await fc.assert(
      fc.asyncProperty(fc.jsonValue(), async (payload) => {
        const error = nextError(socket);
        socket.emit('market.subscribe', payload);
        const response = await error;
        expect(response.data.code).toBe('REQUEST_MALFORMED');
        expect(JSON.stringify(response)).not.toContain('trader-key');
      }),
      { seed: 18_003, numRuns: 16 },
    );

    socket.emit('market.unknown', { requestId: 'unknown-event', payload: 'ignored' });
    const heartbeat = nextError(socket);
    socket.emit('heartbeat', { requestId: 'heartbeat-invalid', sentAt: 42 });
    expect((await heartbeat).data.code).toBe('REQUEST_MALFORMED');
    expect(socket.connected).toBe(true);
  });
});
