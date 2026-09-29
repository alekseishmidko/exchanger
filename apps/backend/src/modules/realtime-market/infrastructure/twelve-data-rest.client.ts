import { z } from 'zod';
import type { RealtimeAssetClass, RealtimeInstrument } from '@exchange/contracts';
import {
  normalizeExternalInstrument,
  type ProviderInstrument,
} from '../domain/external-instrument';
import type {
  ProviderQuote,
  ReferenceDataProviderPort,
} from '../ports/reference-data-provider.port';

const pageSchema = z
  .object({
    count: z.number().int().nonnegative().optional(),
    data: z.array(z.unknown()),
    status: z.string().optional(),
  })
  .passthrough();
const cryptoSchema = z
  .object({ symbol: z.string(), available_exchanges: z.array(z.string()).default([]) })
  .passthrough();
const forexSchema = z.object({ symbol: z.string() }).passthrough();
const stockSchema = z
  .object({
    symbol: z.string(),
    currency: z.string(),
    exchange: z.string(),
    mic_code: z.string().nullable().optional(),
  })
  .passthrough();
const commoditySchema = z.object({ symbol: z.string() }).passthrough();
const quoteSchema = z
  .object({
    close: z.union([z.string(), z.number()]),
    timestamp: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]),
  })
  .passthrough();

/** Allow-listed Twelve Data REST adapter; пользователь не управляет URL или query. */
export class TwelveDataRestClient implements ReferenceDataProviderPort {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly timeoutMs: number,
    private readonly pageSize = 1000,
    private readonly maxPages = 10,
  ) {}

  async loadCatalog(
    assetClass: RealtimeAssetClass,
    syncedAt: Date,
  ): Promise<readonly RealtimeInstrument[]> {
    const path = this.path(assetClass);
    const result: RealtimeInstrument[] = [];
    for (let page = 1; page <= this.maxPages; page += 1) {
      const payload = await this.getPage(path, page);
      for (const value of payload.data) {
        for (const instrument of this.parse(assetClass, value))
          result.push(normalizeExternalInstrument(instrument, syncedAt));
      }
      const complete =
        payload.data.length < this.pageSize ||
        result.length >= (payload.count ?? Number.MAX_SAFE_INTEGER);
      if (complete) return this.unique(result);
      if (page === this.maxPages) throw new Error('TWELVE_DATA_CATALOG_PAGE_LIMIT_EXCEEDED');
    }
    return this.unique(result);
  }

  async loadQuote(instrument: RealtimeInstrument): Promise<ProviderQuote> {
    const url = new URL('/quote', this.baseUrl);
    url.searchParams.set('format', 'JSON');
    url.searchParams.set('symbol', instrument.providerSymbol);
    if (instrument.exchange) url.searchParams.set('exchange', instrument.exchange);
    const response = await fetch(url, {
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: this.headers(),
    });
    if (!response.ok)
      throw new Error(
        response.status === 429 ? 'TWELVE_DATA_RATE_LIMITED' : 'TWELVE_DATA_HTTP_ERROR',
      );
    const value = quoteSchema.parse(await response.json());
    return {
      price: String(value.close),
      providerTimestamp: new Date(Number(value.timestamp) * 1000),
    };
  }

  private async getPage(path: string, page: number): Promise<z.infer<typeof pageSchema>> {
    const url = new URL(path, this.baseUrl);
    url.searchParams.set('format', 'JSON');
    url.searchParams.set('page', String(page));
    url.searchParams.set('outputsize', String(this.pageSize));
    const response = await fetch(url, {
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: this.headers(),
    });
    if (!response.ok)
      throw new Error(
        response.status === 429 ? 'TWELVE_DATA_RATE_LIMITED' : 'TWELVE_DATA_HTTP_ERROR',
      );
    return pageSchema.parse(await response.json());
  }

  /** REST-аутентификация не помещает secret в URL, access logs или error messages. */
  private headers(): Readonly<Record<string, string>> {
    return { accept: 'application/json', authorization: `apikey ${this.apiKey}` };
  }

  private unique(values: readonly RealtimeInstrument[]): readonly RealtimeInstrument[] {
    return [...new Map(values.map((item) => [item.id, item])).values()];
  }

  private path(assetClass: RealtimeAssetClass): string {
    if (assetClass === 'CRYPTO') return '/cryptocurrencies';
    if (assetClass === 'FOREX') return '/forex_pairs';
    if (assetClass === 'STOCK') return '/stocks';
    return '/commodities';
  }

  private parse(assetClass: RealtimeAssetClass, input: unknown): readonly ProviderInstrument[] {
    if (assetClass === 'CRYPTO') {
      const value = cryptoSchema.parse(input);
      const pair = this.pair(value.symbol);
      return value.available_exchanges.map((exchange) => ({
        providerSymbol: value.symbol,
        displaySymbol: value.symbol,
        assetClass,
        exchange,
        micCode: null,
        ...pair,
      }));
    }
    if (assetClass === 'FOREX') {
      const value = forexSchema.parse(input);
      return [
        {
          providerSymbol: value.symbol,
          displaySymbol: value.symbol,
          assetClass,
          exchange: null,
          micCode: null,
          ...this.pair(value.symbol),
        },
      ];
    }
    if (assetClass === 'STOCK') {
      const value = stockSchema.parse(input);
      return [
        {
          providerSymbol: value.symbol,
          displaySymbol: value.symbol,
          assetClass,
          exchange: value.exchange,
          micCode: value.mic_code ?? null,
          baseAssetId: value.symbol,
          quoteAssetId: value.currency,
        },
      ];
    }
    const value = commoditySchema.parse(input);
    return [
      {
        providerSymbol: value.symbol,
        displaySymbol: value.symbol,
        assetClass,
        exchange: 'Commodity',
        micCode: null,
        ...this.pair(value.symbol),
      },
    ];
  }

  private pair(symbol: string): Readonly<{ baseAssetId: string; quoteAssetId: string }> {
    const values = symbol.split('/');
    if (values.length !== 2 || !values[0] || !values[1])
      throw new Error('TWELVE_DATA_SYMBOL_INVALID');
    return { baseAssetId: values[0], quoteAssetId: values[1] };
  }
}
