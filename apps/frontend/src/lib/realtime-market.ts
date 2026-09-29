export type RealtimeAssetClass = 'CRYPTO' | 'FOREX' | 'STOCK' | 'COMMODITY';

export type RealtimeInstrument = Readonly<{
  id: string;
  displaySymbol: string;
  providerSymbol: string;
  assetClass: RealtimeAssetClass;
  exchange: string | null;
  priceEnabled: boolean;
  tradeEnabled: boolean;
  status: 'ACTIVE' | 'INACTIVE';
  source: 'TwelveData';
}>;

export type RealtimeQuote = Readonly<{
  quoteId: string;
  instrumentId: string;
  price: string;
  source: 'TwelveData';
  providerTimestamp: string;
  receivedAt: string;
  expiresAt: string;
  status: 'FRESH' | 'STALE';
}>;

export type RealtimeQuoteSnapshot = Readonly<{
  instrumentId: string;
  status: 'FRESH' | 'STALE' | 'UNAVAILABLE';
  quote: RealtimeQuote | null;
}>;

export type RealtimeCatalogPage = Readonly<{
  items: readonly RealtimeInstrument[];
  nextCursor: string | null;
}>;

/** Строит только allow-listed query локального catalog endpoint. */
export function realtimeCatalogPath(
  filters: Readonly<{
    query?: string;
    assetClass?: '' | RealtimeAssetClass;
    cursor?: string | null;
    limit?: number;
  }>,
): string {
  const params = new URLSearchParams({ limit: String(filters.limit ?? 100), status: 'ACTIVE' });
  if (filters.query?.trim()) params.set('query', filters.query.trim());
  if (filters.assetClass) params.set('assetClass', filters.assetClass);
  if (filters.cursor) params.set('cursor', filters.cursor);
  return `/api/v1/realtime/instruments?${params.toString()}`;
}

export function parseRealtimeCatalog(input: unknown): RealtimeCatalogPage {
  if (!isRecord(input) || !Array.isArray(input['items']))
    throw new Error('CATALOG_RESPONSE_INVALID');
  const items = input['items'].filter(isRealtimeInstrument);
  if (items.length !== input['items'].length) throw new Error('CATALOG_RESPONSE_INVALID');
  const nextCursor = input['nextCursor'];
  if (nextCursor !== null && typeof nextCursor !== 'string')
    throw new Error('CATALOG_RESPONSE_INVALID');
  return { items, nextCursor };
}

export function parseRealtimeQuoteSnapshots(input: unknown): readonly RealtimeQuoteSnapshot[] {
  if (!isRecord(input) || !Array.isArray(input['items'])) throw new Error('QUOTE_RESPONSE_INVALID');
  const values = input['items'].filter(isQuoteSnapshot);
  if (values.length !== input['items'].length) throw new Error('QUOTE_RESPONSE_INVALID');
  return values;
}

export function parseRealtimeQuote(input: unknown): RealtimeQuote | null {
  return isRealtimeQuote(input) ? input : null;
}

export function initialRealtimeSelection(
  instruments: readonly RealtimeInstrument[],
  limit = 20,
): readonly string[] {
  return instruments
    .filter(({ status, priceEnabled }) => status === 'ACTIVE' && priceEnabled)
    .slice(0, limit)
    .map(({ id }) => id);
}

export function quoteFreshness(
  quote: RealtimeQuote | undefined,
  nowMs: number,
): 'FRESH' | 'STALE' | 'UNAVAILABLE' {
  if (!quote) return 'UNAVAILABLE';
  return nowMs < Date.parse(quote.expiresAt) ? 'FRESH' : 'STALE';
}

function isRealtimeInstrument(value: unknown): value is RealtimeInstrument {
  return (
    isRecord(value) &&
    typeof value['id'] === 'string' &&
    typeof value['displaySymbol'] === 'string' &&
    typeof value['providerSymbol'] === 'string' &&
    ['CRYPTO', 'FOREX', 'STOCK', 'COMMODITY'].includes(String(value['assetClass'])) &&
    (value['exchange'] === null || typeof value['exchange'] === 'string') &&
    typeof value['priceEnabled'] === 'boolean' &&
    typeof value['tradeEnabled'] === 'boolean' &&
    (value['status'] === 'ACTIVE' || value['status'] === 'INACTIVE') &&
    value['source'] === 'TwelveData'
  );
}

function isQuoteSnapshot(value: unknown): value is RealtimeQuoteSnapshot {
  return (
    isRecord(value) &&
    typeof value['instrumentId'] === 'string' &&
    ['FRESH', 'STALE', 'UNAVAILABLE'].includes(String(value['status'])) &&
    (value['quote'] === null || isRealtimeQuote(value['quote']))
  );
}

function isRealtimeQuote(value: unknown): value is RealtimeQuote {
  return (
    isRecord(value) &&
    typeof value['quoteId'] === 'string' &&
    typeof value['instrumentId'] === 'string' &&
    typeof value['price'] === 'string' &&
    value['source'] === 'TwelveData' &&
    typeof value['providerTimestamp'] === 'string' &&
    typeof value['receivedAt'] === 'string' &&
    typeof value['expiresAt'] === 'string' &&
    (value['status'] === 'FRESH' || value['status'] === 'STALE')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
