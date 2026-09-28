import type { RealtimeAssetClass, RealtimeInstrument } from '@exchange/contracts';

export const REALTIME_CATALOG_PORT = Symbol('REALTIME_CATALOG_PORT');

export type RealtimeCatalogQuery = Readonly<{
  limit: number;
  cursor: number;
  assetClass?: RealtimeAssetClass;
  exchange?: string;
  status?: 'ACTIVE' | 'INACTIVE';
  query?: string;
}>;

export type RealtimeCatalogPage = Readonly<{
  items: readonly RealtimeInstrument[];
  nextCursor: string | null;
}>;

export interface RealtimeCatalogPort {
  list(query: RealtimeCatalogQuery): Promise<RealtimeCatalogPage>;
  get(id: string): Promise<RealtimeInstrument | null>;
  findStreamable(): Promise<readonly RealtimeInstrument[]>;
  setPriceEnabled(id: string, enabled: boolean): Promise<RealtimeInstrument | null>;
  setTradeEnabled(id: string, enabled: boolean): Promise<RealtimeInstrument | null>;
  publishSnapshot(
    assetClass: RealtimeAssetClass,
    instruments: readonly RealtimeInstrument[],
    minimumRetainedRatio: number,
  ): Promise<Readonly<{ inserted: number; updated: number; deactivated: number }>>;
}
