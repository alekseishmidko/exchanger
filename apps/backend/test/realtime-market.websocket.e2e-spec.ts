import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { io, type Socket } from 'socket.io-client';
import { AppModule } from '../src/app.module';
import { ApiKeyRegistry } from '../src/modules/auth';
import {
  QUOTE_STORE_PORT,
  REALTIME_CATALOG_PORT,
  type QuoteStorePort,
} from '../src/modules/realtime-market';
import { RealtimeMarketHub } from '../src/modules/realtime-market/application/realtime-market-hub';
import { createReferenceQuote } from '../src/modules/realtime-market/domain/reference-quote';
import { normalizeExternalInstrument } from '../src/modules/realtime-market/domain/external-instrument';
import { MemoryQuoteStore } from '../src/modules/realtime-market/infrastructure/memory-quote.store';
import { MemoryRealtimeCatalog } from '../src/modules/realtime-market/infrastructure/memory-realtime-catalog';

type Envelope = Readonly<{ version: number; requestId: string; data: Record<string, unknown> }>;

describe('Realtime market WebSocket transport', () => {
  let app: NestFastifyApplication;
  let socket: Socket;
  let quotes: QuoteStorePort;
  let hub: RealtimeMarketHub;
  const instrumentId = 'td:forex:aggregate:EUR-USD';

  beforeAll(async () => {
    const catalog = new MemoryRealtimeCatalog();
    const instrument = normalizeExternalInstrument(
      {
        providerSymbol: 'EUR/USD',
        displaySymbol: 'EUR/USD',
        assetClass: 'FOREX',
        exchange: null,
        micCode: null,
        baseAssetId: 'EUR',
        quoteAssetId: 'USD',
      },
      new Date(),
    );
    await catalog.publishSnapshot('FOREX', [instrument], 0.5);
    await catalog.setPriceEnabled(instrument.id, true);
    const store = new MemoryQuoteStore();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ApiKeyRegistry)
      .useValue(new ApiKeyRegistry([{ keyId: 'realtime-key', role: 'trader', userId: 'user-1' }]))
      .overrideProvider(REALTIME_CATALOG_PORT)
      .useValue(catalog)
      .overrideProvider(QUOTE_STORE_PORT)
      .useValue(store)
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.listen(0, '127.0.0.1');
    quotes = app.get(QUOTE_STORE_PORT);
    hub = app.get(RealtimeMarketHub);
    socket = io(`${await app.getUrl()}/realtime-market-data`, {
      transports: ['websocket'],
      reconnection: false,
      auth: { apiKey: 'realtime-key' },
    });
    await event(socket, 'connect');
  });

  afterAll(async () => {
    socket?.disconnect();
    await app?.close();
  });

  it('sends ack, initial snapshot and subsequent local-cache updates', async () => {
    const first = await putQuote('1.10', new Date());
    const ack = event(socket, 'realtime.ack');
    const snapshot = event(socket, 'realtime.quote');
    socket.emit('realtime.subscribe', { requestId: 'subscribe-1', instrumentIds: [instrumentId] });
    await expect(ack).resolves.toMatchObject({
      requestId: 'subscribe-1',
      data: { action: 'subscribed', instrumentIds: [instrumentId] },
    });
    await expect(snapshot).resolves.toMatchObject({
      data: { quoteId: first.quoteId, price: '1.1' },
    });

    const update = event(socket, 'realtime.quote');
    const next = await putQuote('1.11', new Date(Date.now() + 1));
    await expect(update).resolves.toMatchObject({ data: { quoteId: next.quoteId, price: '1.11' } });
  });

  it('delivers private execution events only through the authenticated user channel', async () => {
    const received = event(socket, 'realtime.execution');
    await hub.publishExecution('user-1', {
      commandId: 'command-1',
      orderId: 'order-1',
      executionId: 'execution-1',
      accountId: 'account-1',
      instrumentId,
      side: 'BUY',
      quantity: '1',
      price: '1.1',
      notional: '1.1',
      fee: '0',
      quoteId: 'quote-1',
      priceSource: 'TwelveData',
      priceType: 'LAST',
      providerTimestamp: new Date().toISOString(),
      receivedAt: new Date().toISOString(),
      status: 'FILLED',
      createdAt: new Date().toISOString(),
    });
    await expect(received).resolves.toMatchObject({
      data: { orderId: 'order-1', status: 'FILLED' },
    });
  });

  async function putQuote(price: string, now: Date) {
    const quote = createReferenceQuote(
      { instrumentId, price, providerTimestamp: now, receivedAt: now },
      1n,
      60_000,
    );
    const { sequence, ...draft } = quote;
    void sequence;
    const stored = await quotes.putLatest(draft);
    if (!stored) throw new Error('Quote was not stored');
    return stored;
  }
});

function event(socket: Socket, name: string): Promise<Envelope> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${name}`)), 3_000);
    socket.once(name, (value: Envelope) => {
      clearTimeout(timeout);
      resolve(value);
    });
  });
}
