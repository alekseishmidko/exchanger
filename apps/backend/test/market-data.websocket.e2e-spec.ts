import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../src/app.module';
import { MarketDataHub } from '../src/modules/market-data/domain/market-data';
import { ApiKeyRegistry } from '../src/modules/gateway';
import {
  heartbeatPayload,
  marketDataApiKeyRegistry,
  marketDataClient,
  MarketDataClient,
  nextEnvelope,
  privateUserSubscription,
  publicBookSubscription,
  publishDefaultBookSnapshot,
  TestEnvelope,
  waitForConnection,
} from './builders/market-data-builders';

describe('Market data WebSocket transport', () => {
  let app: NestFastifyApplication;
  let hub: MarketDataHub;
  let endpoint: string;
  const clients: MarketDataClient[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ApiKeyRegistry)
      .useValue(marketDataApiKeyRegistry())
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.listen(0, '127.0.0.1');
    endpoint = `${await app.getUrl()}/market-data`;
    hub = app.get(MarketDataHub);
  });

  beforeEach(() => {
    publishDefaultBookSnapshot(hub);
  });

  afterEach(() => {
    for (const client of clients.splice(0)) client.disconnect();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  /** Создаёт client с отключённым polling и автоматическим reconnect. */
  function client(apiKey?: string): MarketDataClient {
    const socket = marketDataClient(endpoint, apiKey);
    clients.push(socket);
    return socket;
  }

  it('delivers ack, snapshot and ordered increment to a public subscriber', async () => {
    const socket = client();
    await waitForConnection(socket);
    const ack = nextEnvelope(socket, 'market.ack');
    const snapshot = nextEnvelope(socket, 'market.data');
    socket.emit('market.subscribe', publicBookSubscription());

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
    first.emit('market.subscribe', publicBookSubscription('before-disconnect'));
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
    socket.emit('market.subscribe', privateUserSubscription('private-forbidden', 'user-2'));
    expect(await forbidden).toMatchObject({
      correlationId: 'private-forbidden',
      data: { code: 'PRIVATE_STREAM_FORBIDDEN' },
    });

    const ack = nextEnvelope(socket, 'market.ack');
    socket.emit('market.subscribe', privateUserSubscription('private-user-1', 'user-1'));
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
    socket.emit('market.subscribe', privateUserSubscription('private-no-auth', 'user-1'));
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
    socket.emit('heartbeat', heartbeatPayload());
    expect(await response).toMatchObject({
      correlationId: 'heartbeat-1',
      sequence: 0,
      data: { sentAt: '2026-09-09T00:00:00.000Z' },
    });
  });

  it('handles subscription churn, invalid ack ordering and extreme sequence values safely', async () => {
    const socket = client('user-1-key');
    await waitForConnection(socket);

    for (let index = 0; index < 12; index += 1) {
      const ack = nextEnvelope(socket, 'market.ack');
      socket.emit('market.subscribe', {
        requestId: `churn-subscribe-${index}`,
        channel: 'book',
        instrumentId: 'BTC-USD',
      });
      expect(await ack).toMatchObject({
        correlationId: `churn-subscribe-${index}`,
        sequence: 0,
      });
      const unsubscribe = nextEnvelope(socket, 'market.ack');
      socket.emit('market.unsubscribe', {
        requestId: `churn-unsubscribe-${index}`,
        channel: 'book',
        instrumentId: 'BTC-USD',
      });
      expect(await unsubscribe).toMatchObject({
        correlationId: `churn-unsubscribe-${index}`,
        sequence: 0,
      });
    }

    const malformed = nextEnvelope(socket, 'market.error');
    socket.emit('market.unsubscribe', {
      requestId: 'invalid-ack-ordering',
      channel: 'book',
      instrumentId: 'BTC-USD',
      unexpectedAckSequence: 1,
    });
    expect(await malformed).toMatchObject({
      correlationId: 'invalid-ack-ordering',
      sequence: 0,
      data: { code: 'REQUEST_MALFORMED' },
    });

    hub.publishSnapshot({
      channel: 'book',
      instrumentId: 'ETH-USD',
      sequence: Number.MAX_SAFE_INTEGER - 1,
      bids: [],
      asks: [],
    });
    const replay = nextEnvelope(socket, 'market.data');
    socket.emit('market.resync', {
      requestId: 'large-sequence-resync',
      instrumentId: 'ETH-USD',
      lastSequence: Number.MAX_SAFE_INTEGER - 2,
    });
    expect(await replay).toMatchObject({
      correlationId: 'large-sequence-resync',
      sequence: Number.MAX_SAFE_INTEGER - 1,
    });
    expect(socket.connected).toBe(true);
  });
});
