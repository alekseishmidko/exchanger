import { once } from 'node:events';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  TwelveDataWebSocketClient,
  parseTwelveDataServerEvent,
} from './twelve-data-websocket.client';

describe('TwelveDataWebSocketClient', () => {
  const servers: WebSocketServer[] = [];
  const clients: TwelveDataWebSocketClient[] = [];

  afterEach(async () => {
    for (const client of clients) client.close();
    for (const server of servers) {
      for (const socket of server.clients) socket.terminate();
      server.close();
      await once(server, 'close');
    }
    clients.length = 0;
    servers.length = 0;
  });

  it('waits for a complete subscription acknowledgement before becoming ready', async () => {
    let requestUrl = '';
    const subscribed = jest.fn();
    const server = await fakeServer((socket, url) => {
      requestUrl = url;
      socket.once('message', (raw) => {
        const text = Buffer.isBuffer(raw)
          ? raw.toString('utf8')
          : raw instanceof ArrayBuffer
            ? Buffer.from(raw).toString('utf8')
            : Buffer.concat(raw).toString('utf8');
        subscribed(JSON.parse(text));
        socket.send(
          JSON.stringify({
            event: 'subscribe-status',
            status: 'ok',
            success: [{ symbol: 'EUR/USD', exchange: '' }],
            fails: null,
          }),
        );
      });
    });
    const price = jest.fn(() => Promise.resolve());
    const invalid = jest.fn();
    const client = createClient(server.url, price, invalid);

    await expect(client.connect(['EUR/USD'])).resolves.toBeUndefined();
    expect(new URL(requestUrl, 'ws://localhost').searchParams.get('apikey')).toBe('provider-key');
    expect(subscribed).toHaveBeenCalledWith({
      action: 'subscribe',
      params: { symbols: 'EUR/USD' },
    });
    expect(invalid).not.toHaveBeenCalled();
  });

  it('rejects partial subscriptions without exposing the provider key', async () => {
    const server = await fakeServer((socket) => {
      socket.once('message', () => {
        socket.send(
          JSON.stringify({
            event: 'subscribe-status',
            status: 'warning',
            success: [{ symbol: 'EUR/USD' }],
            fails: [{ symbol: 'BTC/USD' }],
          }),
        );
      });
    });
    const client = createClient(
      server.url,
      jest.fn(() => Promise.resolve()),
      jest.fn(),
    );

    const failure = client.connect(['EUR/USD', 'BTC/USD']);
    await expect(failure).rejects.toThrow('TWELVE_DATA_WS_SUBSCRIPTION_REJECTED');
    await expect(failure).rejects.not.toThrow('provider-key');
  });

  it('ignores heartbeat control events but reports malformed payloads', async () => {
    const invalid = jest.fn();
    const server = await fakeServer((socket) => {
      socket.once('message', () => {
        socket.send(JSON.stringify({ event: 'heartbeat', status: 'ok' }));
        socket.send('{bad-json');
        socket.send(
          JSON.stringify({
            event: 'subscribe-status',
            status: 'ok',
            success: [{ symbol: 'EUR/USD' }],
            fails: null,
          }),
        );
      });
    });
    const client = createClient(
      server.url,
      jest.fn(() => Promise.resolve()),
      invalid,
    );

    await client.connect(['EUR/USD']);
    expect(invalid).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the provider does not acknowledge the subscription in time', async () => {
    const server = await fakeServer(() => undefined);
    const client = createClient(
      server.url,
      jest.fn(() => Promise.resolve()),
      jest.fn(),
      20,
    );

    await expect(client.connect(['EUR/USD'])).rejects.toThrow(
      'TWELVE_DATA_WS_SUBSCRIPTION_TIMEOUT',
    );
  });

  it('parses price, subscription and heartbeat events as distinct protocol messages', () => {
    expect(
      parseTwelveDataServerEvent(
        JSON.stringify({
          event: 'price',
          symbol: 'EUR/USD',
          price: '1.2',
          timestamp: 1_800_000_000,
        }),
      ),
    ).toMatchObject({ type: 'price', value: { symbol: 'EUR/USD' } });
    expect(
      parseTwelveDataServerEvent(
        JSON.stringify({ event: 'subscribe-status', status: 'ok', success: [], fails: null }),
      ),
    ).toMatchObject({ type: 'subscription', status: 'ok', failed: [] });
    expect(parseTwelveDataServerEvent(JSON.stringify({ event: 'heartbeat' }))).toEqual({
      type: 'heartbeat',
    });
    expect(parseTwelveDataServerEvent(JSON.stringify({ event: 'unknown' }))).toBeNull();
  });

  function createClient(
    url: string,
    onPrice: jest.Mock<Promise<void>, []>,
    onInvalid: jest.Mock,
    subscriptionAckTimeoutMs = 1_000,
  ): TwelveDataWebSocketClient {
    const client = new TwelveDataWebSocketClient(
      url,
      'provider-key',
      60_000,
      subscriptionAckTimeoutMs,
      onPrice,
      jest.fn(),
      onInvalid,
    );
    clients.push(client);
    return client;
  }

  async function fakeServer(
    onConnection: (socket: WebSocket, url: string) => void,
  ): Promise<{ url: string }> {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    servers.push(server);
    await once(server, 'listening');
    server.on('connection', (socket, request) => onConnection(socket, request.url ?? ''));
    const address = server.address();
    if (typeof address === 'string' || address === null) throw new Error('Fake WS address missing');
    return { url: `ws://127.0.0.1:${address.port}` };
  }
});
