import type { RealtimeAssetClass, RealtimeInstrument } from '@exchange/contracts';

export const REFERENCE_DATA_PROVIDER = Symbol('REFERENCE_DATA_PROVIDER');

export type ProviderQuote = Readonly<{
  price: string;
  providerTimestamp: Date;
}>;

export interface ReferenceDataProviderPort {
  loadCatalog(
    assetClass: RealtimeAssetClass,
    syncedAt: Date,
  ): Promise<readonly RealtimeInstrument[]>;
  loadQuote(instrument: RealtimeInstrument): Promise<ProviderQuote>;
}
