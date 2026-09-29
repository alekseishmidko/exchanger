import assert from 'node:assert/strict';
import test from 'node:test';
import {
  initialRealtimeSelection,
  parseRealtimeCatalog,
  parseRealtimeQuoteSnapshots,
  quoteFreshness,
  realtimeCatalogPath,
} from '../src/lib/realtime-market.ts';

const instrument = {
  id: 'td:crypto:Coinbase:BTC-USD',
  displaySymbol: 'BTC/USD',
  providerSymbol: 'BTC/USD',
  assetClass: 'CRYPTO' as const,
  exchange: 'Coinbase',
  priceEnabled: true,
  tradeEnabled: false,
  status: 'ACTIVE' as const,
  source: 'TwelveData' as const,
};

test('builds bounded local catalog queries and never accepts provider URLs', () => {
  const path = realtimeCatalogPath({ query: 'BTC/USD', assetClass: 'CRYPTO', cursor: '100' });
  assert.equal(path.startsWith('/api/v1/realtime/instruments?'), true);
  const url = new URL(path, 'http://local');
  assert.equal(url.searchParams.get('query'), 'BTC/USD');
  assert.equal(url.searchParams.get('limit'), '100');
  assert.equal(url.searchParams.get('cursor'), '100');
});

test('strictly parses catalog and selects only price-enabled instruments', () => {
  const disabled = { ...instrument, id: 'disabled', priceEnabled: false };
  const page = parseRealtimeCatalog({ items: [instrument, disabled], nextCursor: null });
  assert.deepEqual(initialRealtimeSelection(page.items), [instrument.id]);
  assert.throws(() => parseRealtimeCatalog({ items: [{ ...instrument, source: 'Other' }] }));
});

test('parses quote snapshots and derives freshness from expiresAt', () => {
  const quote = {
    quoteId: 'quote-1',
    instrumentId: instrument.id,
    price: '65000.25',
    source: 'TwelveData' as const,
    providerTimestamp: '2026-09-29T00:00:00.000Z',
    receivedAt: '2026-09-29T00:00:00.100Z',
    expiresAt: '2026-09-29T00:00:05.000Z',
    status: 'FRESH' as const,
  };
  const snapshots = parseRealtimeQuoteSnapshots({
    items: [{ instrumentId: instrument.id, status: 'FRESH', quote }],
  });
  assert.equal(snapshots[0]?.quote?.price, '65000.25');
  assert.equal(quoteFreshness(quote, Date.parse('2026-09-29T00:00:04.999Z')), 'FRESH');
  assert.equal(quoteFreshness(quote, Date.parse('2026-09-29T00:00:05.000Z')), 'STALE');
});
