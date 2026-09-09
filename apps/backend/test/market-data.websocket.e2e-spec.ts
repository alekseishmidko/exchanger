import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { io, Socket } from 'socket.io-client';
import { AppModule } from '../src/app.module';
import { ApiKeyRegistry } from '../src/modules/gateway/gateway.auth';
import { MarketDataHub } from '../src/modules/market-data/market-data';

/** Минимальный envelope shape, проверяемый WebSocket integration-тестом. */
type TestEnvelope = Readonly<{
  messageVersion: string;
  correlationId: string;
  emittedAt: string;
  sequence: number;
  data: unknown;
}>;

/** Типы server events тестового Socket.IO client. */
interface ServerEvents {
  [event: string]: (payload: TestEnvelope) => void;
}

/** Типы client commands; runtime payload всё равно проверяет Zod на сервере. */
interface ClientEvents {
  [event: string]: (payload: unknown) => void;
}

/** Socket.IO client с versioned envelope server events. */
type MarketDataClient = Socket<ServerEvents, ClientEvents>;

/** Ожидает одно server event и завершает тест по timeout вместо зависания. */
function nextEnvelope(
  socket: MarketDataClient,
  event: 'market.data' | 'market.ack' | 'market.error' | 'heartbeat.ack',
): Promise<TestEnvelope> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), 2000);
    socket.once(event, (payload) => {
      clearTimeout(timeout);
      resolve(payload);
    });
  });
}

/** Дожидается реального namespace connection либо отдаёт connect_error. */
function waitForConnection(socket: MarketDataClient): Promise<void> {
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

describe('Market data WebSocket transport', () => {
  let app: NestFastifyApplication;
  let hub: MarketDataHub;
  let endpoint: string;
  const clients: MarketDataClient[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ApiKeyRegistry)
      .useValue(
        new ApiKeyRegistry([
          { keyId: 'user-1-key', role: 'trader', userId: 'user-1' },
          { keyId: 'user-2-key', role: 'trader', userId: 'user-2' },
        ]),
      )
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.listen(0, '127.0.0.1');
    endpoint = `${await app.getUrl()}/market-data`;
    hub = app.get(MarketDataHub);
  });

  beforeEach(() => {
    hub.publishSnapshot({
      channel: 'book',
      instrumentId: 'BTC-USD',
      sequence: 1,
      bids: [{ price: '60000', quantity: '1' }],
      asks: [{ price: '60000.5', quantity: '2' }],
    });
  });

  afterEach(() => {
    for (const client of clients.splice(0)) client.disconnect();
  });

  afterAll(async () => app.close());

  /** Создаёт client с отключённым polling и автоматическим reconnect. */
  function client(apiKey?: string): MarketDataClient {
    const socket = io(endpoint, {
      autoConnect: false,
      transports: ['websocket'],
      reconnection: false,
      ...(apiKey ? { auth: { apiKey } } : {}),
    });
    clients.push(socket);
    return socket;
  }

  it('delivers ack, snapshot and ordered increment to a public subscriber', async () => {
    const socket = client();
    await waitForConnection(socket);
    const ack = nextEnvelope(socket, 'market.ack');
    const snapshot = nextEnvelope(socket, 'market.data');
    socket.emit('market.subscribe', {
      requestId: 'public-book-1',
      channel: 'book',
      instrumentId: 'BTC-USD',
    });

    expect(await ack).toMatchObject({
      messageVersion: '1.0',
      correlationId: 'public-book-1',
      sequence: 0,
      data: { action: 'subscribed', subscription: 'book:BTC-USD' },
    });
    expect(await snapshot).toMatchObject({
      correlationId: 'public-book-1',
      sequence: 1,
      data: { channel: 'book', instrumentId: 'BTC-USD', sequence: 1 },
    });

    const increment = nextEnvelope(socket, 'market.data');
    hub.publishIncrement({
      channel: 'book_update',
      instrumentId: 'BTC-USD',
      sequence: 2,
      bids: [{ price: '60000', quantity: '0.5' }],
      asks: [],
    });
    expect(await increment).toMatchObject({
      sequence: 2,
      data: { channel: 'book_update', sequence: 2 },
    });
  });

  it('recovers after disconnect using ordered replay and removes old subscriptions', async () => {
    const first = client();
    await waitForConnection(first);
    const firstSnapshot = nextEnvelope(first, 'market.data');
    first.emit('market.subscribe', {
      requestId: 'before-disconnect',
      channel: 'book',
      instrumentId: 'BTC-USD',
    });
    await firstSnapshot;
    hub.publishIncrement({
      channel: 'book_update',
      instrumentId: 'BTC-USD',
      sequence: 2,
      bids: [{ price: '60000', quantity: '0.75' }],
      asks: [],
    });
    first.disconnect();

    const reconnect = client();
    await waitForConnection(reconnect);
    const replay = nextEnvelope(reconnect, 'market.data');
    reconnect.emit('market.resync', {
      requestId: 'resync-after-disconnect',
      instrumentId: 'BTC-USD',
      lastSequence: 1,
    });
    expect(await replay).toMatchObject({
      correlationId: 'resync-after-disconnect',
      sequence: 2,
      data: { channel: 'book_update', sequence: 2 },
    });
  });

  it('authorizes private subscriptions and never leaks another user event', async () => {
    const socket = client('user-1-key');
    await waitForConnection(socket);
    const forbidden = nextEnvelope(socket, 'market.error');
    socket.emit('market.subscribe', {
      requestId: 'private-forbidden',
      channel: 'user',
      userId: 'user-2',
    });
    expect(await forbidden).toMatchObject({
      correlationId: 'private-forbidden',
      data: { code: 'PRIVATE_STREAM_FORBIDDEN' },
    });

    const ack = nextEnvelope(socket, 'market.ack');
    socket.emit('market.subscribe', {
      requestId: 'private-user-1',
      channel: 'user',
      userId: 'user-1',
    });
    await ack;

    const received: TestEnvelope[] = [];
    socket.on('market.data', (event) => received.push(event));
    hub.publishPrivate({
      channel: 'user',
      userId: 'user-2',
      sequence: 1,
      type: 'ORDER_UPDATED',
      payload: { orderId: 'foreign-order' },
    });
    const own = nextEnvelope(socket, 'market.data');
    hub.publishPrivate({
      channel: 'user',
      userId: 'user-1',
      sequence: 2,
      type: 'ORDER_UPDATED',
      payload: { orderId: 'own-order', status: 'FILLED' },
    });
    expect(await own).toMatchObject({
      sequence: 2,
      data: { channel: 'user', userId: 'user-1', payload: { orderId: 'own-order' } },
    });
    expect(received).toHaveLength(1);
  });

  it('rejects unauthenticated private and malformed commands without secrets', async () => {
    const socket = client();
    await waitForConnection(socket);
    const authError = nextEnvelope(socket, 'market.error');
    socket.emit('market.subscribe', {
      requestId: 'private-no-auth',
      channel: 'user',
      userId: 'user-1',
    });
    expect(await authError).toMatchObject({ data: { code: 'AUTH_REQUIRED' } });

    const malformed = nextEnvelope(socket, 'market.error');
    socket.emit('market.subscribe', {
      requestId: 'malformed-1',
      channel: 'book',
      instrumentId: 'BTC-USD',
      apiKey: 'must-not-leak',
    });
    const response = await malformed;
    expect(response).toMatchObject({
      correlationId: 'malformed-1',
      sequence: 0,
      data: { code: 'REQUEST_MALFORMED' },
    });
    expect(JSON.stringify(response)).not.toContain('must-not-leak');
  });

  it('responds to heartbeat without market-data dependencies', async () => {
    const socket = client();
    await waitForConnection(socket);
    const response = nextEnvelope(socket, 'heartbeat.ack');
    socket.emit('heartbeat', {
      requestId: 'heartbeat-1',
      sentAt: '2026-09-09T00:00:00.000Z',
    });
    expect(await response).toMatchObject({
      correlationId: 'heartbeat-1',
      sequence: 0,
      data: { sentAt: '2026-09-09T00:00:00.000Z' },
    });
  });
});
