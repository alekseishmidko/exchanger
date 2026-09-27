import type { RealtimeAssetClass, RealtimeInstrument } from '@exchange/contracts';

/** Входные данные provider adapter до назначения стабильного локального ID. */
export type ProviderInstrument = Readonly<{
  providerSymbol: string;
  displaySymbol: string;
  assetClass: RealtimeAssetClass;
  exchange: string | null;
  micCode: string | null;
  baseAssetId: string;
  quoteAssetId: string;
}>;

/** Создаёт bounded ASCII ID, однозначный для symbol и venue. */
export function externalInstrumentId(instrument: ProviderInstrument): string {
  const assetClass = instrument.assetClass.toLowerCase();
  const venue = slug(instrument.exchange ?? instrument.micCode ?? 'aggregate');
  const symbol = instrument.providerSymbol.replaceAll('/', '-').replaceAll(':', '-');
  return `td:${assetClass}:${venue}:${slug(symbol).toUpperCase()}`;
}

/** Преобразует provider record в строгий локальный snapshot. */
export function normalizeExternalInstrument(
  instrument: ProviderInstrument,
  syncedAt: Date,
): RealtimeInstrument {
  return {
    id: externalInstrumentId(instrument),
    displaySymbol: instrument.displaySymbol,
    providerSymbol: instrument.providerSymbol,
    assetClass: instrument.assetClass,
    exchange: instrument.exchange,
    micCode: instrument.micCode,
    baseAssetId: normalizeAsset(instrument.baseAssetId),
    quoteAssetId: normalizeAsset(instrument.quoteAssetId),
    priceEnabled: false,
    tradeEnabled: false,
    status: 'ACTIVE',
    source: 'TwelveData',
    syncedAt: syncedAt.toISOString(),
  };
}

function normalizeAsset(value: string): string {
  const normalized = value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9._:-]/g, '-');
  if (!normalized || normalized.length > 128) throw new Error('REALTIME_ASSET_INVALID');
  return normalized;
}

function slug(value: string): string {
  const normalized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!normalized) return 'aggregate';
  return normalized.slice(0, 64);
}
