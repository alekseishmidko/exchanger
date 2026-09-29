import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { ApiKeyRegistry } from '../src/modules/auth';
import { MemoryRealtimeCatalog } from '../src/modules/realtime-market/infrastructure/memory-realtime-catalog';
import {
  QUOTE_STORE_PORT,
  REALTIME_CATALOG_PORT,
  type QuoteStorePort,
  type RealtimeCatalogPort,
} from '../src/modules/realtime-market';
import { normalizeExternalInstrument } from '../src/modules/realtime-market/domain/external-instrument';
import { createReferenceQuote } from '../src/modules/realtime-market/domain/reference-quote';
import { TwelveDataDiagnosticsService } from '../src/modules/realtime-market/application/twelve-data-diagnostics.service';

describe('Realtime market HTTP boundary', () => {
  let app: NestFastifyApplication;

  beforeEach(async () => {
    const catalog = new MemoryRealtimeCatalog();
    await catalog.publishSnapshot(
      'FOREX',
      [
        normalizeExternalInstrument(
          {
            providerSymbol: 'EUR/USD',
            displaySymbol: 'EUR/USD',
            assetClass: 'FOREX',
            exchange: null,
            micCode: null,
            baseAssetId: 'EUR',
            quoteAssetId: 'USD',
          },
          new Date('2026-09-28T00:00:00.000Z'),
        ),
      ],
      0.5,
    );
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ApiKeyRegistry)
      .useValue(
        new ApiKeyRegistry([
          { keyId: 'realtime-key', role: 'trader', userId: 'user-1' },
          { keyId: 'realtime-admin', role: 'admin', userId: 'admin-1' },
        ]),
      )
      .overrideProvider(REALTIME_CATALOG_PORT)
      .useValue(catalog)
      .overrideProvider(TwelveDataDiagnosticsService)
      .useValue({
        inspect: jest.fn().mockResolvedValue({
          provider: 'TwelveData',
          transport: 'REST',
          endpoint: '/quote',
          request: { symbol: 'BTC/USD', format: 'JSON' },
          durationMs: 12,
          httpStatus: 200,
          credits: { used: '1', left: '7' },
          body: { symbol: 'BTC/USD', close: '83000' },
        }),
      })
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.listen(0, '127.0.0.1');
  });

  it('changes the price allowlist only through an idempotent admin endpoint', async () => {
    const path = '/api/v1/admin/realtime/instruments/td%3Aforex%3Aaggregate%3AEUR-USD';
    await request(app.getHttpServer())
      .post(`${path}/price-enable`)
      .set('x-api-key', 'realtime-admin')
      .expect(400);
    await request(app.getHttpServer())
      .post(`${path}/price-enable`)
      .set('x-api-key', 'realtime-admin')
      .set('idempotency-key', 'enable-eur-usd')
      .expect(201)
      .expect(({ body }) => expect(body).toMatchObject({ priceEnabled: true }));
    await request(app.getHttpServer())
      .post(`${path}/price-enable`)
      .set('x-api-key', 'realtime-admin')
      .set('idempotency-key', 'enable-eur-usd')
      .expect(201)
      .expect(({ body }) => expect(body).toMatchObject({ priceEnabled: true }));
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  it('serves only the local catalog and enforces authentication', async () => {
    await request(app.getHttpServer()).get('/api/v1/realtime/instruments').expect(401);
    await request(app.getHttpServer())
      .get('/api/v1/realtime/instruments?assetClass=forex&query=EUR')
      .set('x-api-key', 'realtime-key')
      .expect(200)
      .expect((response) => {
        const body = response.body as { items: unknown[] };
        expect(body.items).toEqual([
          expect.objectContaining({ providerSymbol: 'EUR/USD', source: 'TwelveData' }),
        ]);
      });
  });

  it('serves fresh and unavailable quote snapshots only from the local cache', async () => {
    await app
      .get<RealtimeCatalogPort>(REALTIME_CATALOG_PORT)
      .setPriceEnabled('td:forex:aggregate:EUR-USD', true);
    const store = app.get<QuoteStorePort>(QUOTE_STORE_PORT);
    const now = new Date();
    const quote = createReferenceQuote(
      {
        instrumentId: 'td:forex:aggregate:EUR-USD',
        price: '1.125',
        providerTimestamp: now,
        receivedAt: now,
      },
      1n,
      60_000,
    );
    const { sequence, ...draft } = quote;
    void sequence;
    await store.putLatest(draft);
    await request(app.getHttpServer())
      .get('/api/v1/realtime/quotes?instrumentIds=td%3Aforex%3Aaggregate%3AEUR-USD,unknown')
      .set('x-api-key', 'realtime-key')
      .expect(200)
      .expect((response) => {
        const body = response.body as {
          items: Array<{ instrumentId: string; status: string; quote: { price: string } | null }>;
        };
        expect(body.items[0]?.status).toBe('FRESH');
        expect(body.items[0]?.quote?.price).toBe('1.125');
        expect(body.items[1]).toEqual({
          instrumentId: 'unknown',
          status: 'UNAVAILABLE',
          quote: null,
        });
      });
  });

  it('returns bounded disabled provider status without exposing configuration', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/realtime/market-status')
      .set('x-api-key', 'realtime-key')
      .expect(200)
      .expect(({ body }) =>
        expect(body).toEqual({
          state: 'DISABLED',
          lastMessageAt: null,
          lastCatalogSyncAt: null,
          reconnects: 0,
        }),
      );
  });

  it('protects the bounded provider inspector and returns no credentials', async () => {
    const path = '/api/v1/admin/realtime/provider-inspect';
    const body = { transport: 'REST', endpoint: '/quote', symbol: 'BTC/USD' };
    await request(app.getHttpServer()).post(path).send(body).expect(401);
    await request(app.getHttpServer())
      .post(path)
      .set('x-api-key', 'realtime-key')
      .send(body)
      .expect(403);
    await request(app.getHttpServer())
      .post(path)
      .set('x-api-key', 'realtime-admin')
      .send(body)
      .expect(200)
      .expect(({ body: responseBody }) => {
        expect(responseBody).toMatchObject({
          provider: 'TwelveData',
          endpoint: '/quote',
          httpStatus: 200,
        });
        expect(JSON.stringify(responseBody)).not.toContain('apiKey');
      });
  });
});
