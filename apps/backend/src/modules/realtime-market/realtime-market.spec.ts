import { normalizeExternalInstrument } from './domain/external-instrument';
import { createReferenceQuote } from './domain/reference-quote';
import { ExactLastExecutionPricePolicy } from './domain/execution-price.policy';
import { MemoryRealtimeCatalog } from './infrastructure/memory-realtime-catalog';
import { MemoryQuoteStore } from './infrastructure/memory-quote.store';
import { TwelveDataRestClient } from './infrastructure/twelve-data-rest.client';
import { parseTwelveDataPriceEvent } from './infrastructure/twelve-data-websocket.client';

describe('realtime market domain and adapters', () => {
  const syncedAt = new Date('2026-09-28T00:00:00.000Z');

  it('creates venue-aware stable IDs and normalizes assets', () => {
    const value = normalizeExternalInstrument(
      {
        providerSymbol: 'BTC/USD',
        displaySymbol: 'BTC/USD',
        assetClass: 'CRYPTO',
        exchange: 'Coinbase Pro',
        micCode: null,
        baseAssetId: 'btc',
        quoteAssetId: 'usd',
      },
      syncedAt,
    );
    expect(value).toMatchObject({
      id: 'td:crypto:Coinbase-Pro:BTC-USD',
      baseAssetId: 'BTC',
      quoteAssetId: 'USD',
      priceEnabled: false,
    });
  });

  it('builds deterministic quotes and evaluates freshness without floating point', async () => {
    const quote = createReferenceQuote(
      {
        instrumentId: 'td:crypto:Coinbase:BTC-USD',
        price: '60000.5000',
        providerTimestamp: new Date('2026-09-28T00:00:00.000Z'),
        receivedAt: new Date('2026-09-28T00:00:00.100Z'),
      },
      1n,
      5_000,
    );
    expect(quote.price).toBe('60000.5');
    const store = new MemoryQuoteStore();
    const { sequence, ...draft } = quote;
    void sequence;
    expect((await store.putLatest(draft))?.sequence).toBe('1');
    expect(
      (await store.getLatest(quote.instrumentId, new Date('2026-09-28T00:00:06.000Z')))?.status,
    ).toBe('STALE');
    await expect(store.putLatest(draft)).resolves.toBeNull();
  });

  it('rejects future and non-positive provider ticks', () => {
    const base = { instrumentId: 'td:forex:aggregate:EUR-USD', receivedAt: syncedAt };
    expect(() =>
      createReferenceQuote({ ...base, price: '0', providerTimestamp: syncedAt }, 1n, 5000),
    ).toThrow('REALTIME_PRICE_INVALID');
    expect(() =>
      createReferenceQuote(
        { ...base, price: '1', providerTimestamp: new Date(syncedAt.getTime() + 6000) },
        1n,
        5000,
      ),
    ).toThrow('REALTIME_TIMESTAMP_FUTURE');
  });

  it('applies EXACT_LAST only to the expected fresh quote', () => {
    const policy = new ExactLastExecutionPricePolicy();
    const quote = createReferenceQuote(
      {
        instrumentId: 'td:forex:aggregate:EUR-USD',
        price: '1.25',
        providerTimestamp: syncedAt,
        receivedAt: syncedAt,
      },
      1n,
      5_000,
    );
    expect(policy.resolve(quote, quote.quoteId, new Date(syncedAt.getTime() + 1000)).price).toBe(
      '1.25',
    );
    expect(() => policy.resolve(quote, 'q:other', syncedAt)).toThrow('QUOTE_CHANGED');
    expect(() => policy.resolve(quote, quote.quoteId, new Date(syncedAt.getTime() + 5000))).toThrow(
      'QUOTE_STALE',
    );
    expect(() => policy.resolve(null, quote.quoteId, syncedAt)).toThrow(
      'REALTIME_PRICE_UNAVAILABLE',
    );
  });

  it('publishes defensive catalog snapshots and preserves enable flags', async () => {
    const catalog = new MemoryRealtimeCatalog();
    const first = normalizeExternalInstrument(
      {
        providerSymbol: 'EUR/USD',
        displaySymbol: 'EUR/USD',
        assetClass: 'FOREX',
        exchange: null,
        micCode: null,
        baseAssetId: 'EUR',
        quoteAssetId: 'USD',
      },
      syncedAt,
    );
    await catalog.publishSnapshot('FOREX', [first], 0.5);
    await expect(catalog.publishSnapshot('FOREX', [], 0.5)).rejects.toThrow(
      'REALTIME_CATALOG_SNAPSHOT_REJECTED',
    );
    expect((await catalog.list({ limit: 10, cursor: 0, query: 'eur' })).items).toHaveLength(1);
    await expect(catalog.setPriceEnabled(first.id, true)).resolves.toMatchObject({
      id: first.id,
      priceEnabled: true,
    });
    await expect(catalog.findStreamable()).resolves.toHaveLength(1);
  });

  it('loads a bounded REST quote for a catalog-mapped symbol and venue', async () => {
    const original = global.fetch;
    let calledInput: string | URL | Request | undefined;
    global.fetch = jest.fn((input: string | URL | Request) => {
      calledInput = input;
      return Promise.resolve(
        new Response(JSON.stringify({ close: '60000.125', timestamp: 1_800_000_000 }), {
          status: 200,
        }),
      );
    });
    try {
      const client = new TwelveDataRestClient('https://api.twelvedata.com', 'secret-key', 1000);
      const instrument = normalizeExternalInstrument(
        {
          providerSymbol: 'BTC/USD',
          displaySymbol: 'BTC/USD',
          assetClass: 'CRYPTO',
          exchange: 'Coinbase',
          micCode: null,
          baseAssetId: 'BTC',
          quoteAssetId: 'USD',
        },
        syncedAt,
      );
      await expect(client.loadQuote(instrument)).resolves.toEqual({
        price: '60000.125',
        providerTimestamp: new Date(1_800_000_000_000),
      });
      const called = new URL(
        calledInput instanceof Request
          ? calledInput.url
          : calledInput instanceof URL
            ? calledInput.toString()
            : (calledInput ?? ''),
      );
      expect(called.pathname).toBe('/quote');
      expect(called.searchParams.get('symbol')).toBe('BTC/USD');
      expect(called.searchParams.get('exchange')).toBe('Coinbase');
    } finally {
      global.fetch = original;
    }
  });

  it('uses only allow-listed REST paths and expands crypto venues', async () => {
    const original = global.fetch;
    let calledInput: string | URL | Request | undefined;
    const mock = jest.fn((input: string | URL | Request) => {
      calledInput = input;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            count: 1,
            status: 'ok',
            data: [{ symbol: 'BTC/USD', available_exchanges: ['Coinbase', 'Kraken'] }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    });
    global.fetch = mock;
    try {
      const client = new TwelveDataRestClient('https://api.twelvedata.com', 'secret-key', 1000);
      const values = await client.loadCatalog('CRYPTO', syncedAt);
      expect(values.map(({ exchange }) => exchange)).toEqual(['Coinbase', 'Kraken']);
      expect(calledInput).toBeDefined();
      const called = new URL(
        calledInput instanceof Request
          ? calledInput.url
          : calledInput instanceof URL
            ? calledInput.toString()
            : (calledInput ?? ''),
      );
      expect(called.origin + called.pathname).toBe('https://api.twelvedata.com/cryptocurrencies');
      expect(called.searchParams.get('apikey')).toBe('secret-key');
    } finally {
      global.fetch = original;
    }
  });

  it('strictly parses bounded Twelve Data price messages', () => {
    expect(
      parseTwelveDataPriceEvent(
        JSON.stringify({ event: 'price', symbol: 'EUR/USD', price: 1.2, timestamp: 1_800_000_000 }),
      ),
    ).toMatchObject({ symbol: 'EUR/USD', price: 1.2 });
    expect(parseTwelveDataPriceEvent('{bad-json')).toBeNull();
    expect(
      parseTwelveDataPriceEvent(JSON.stringify({ event: 'heartbeat', status: 'ok' })),
    ).toBeNull();
  });
});
