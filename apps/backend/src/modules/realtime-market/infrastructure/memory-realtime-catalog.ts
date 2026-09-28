import type { RealtimeAssetClass, RealtimeInstrument } from '@exchange/contracts';
import type {
  RealtimeCatalogPage,
  RealtimeCatalogPort,
  RealtimeCatalogQuery,
} from '../ports/realtime-catalog.port';

/** Component adapter с той же publish/list семантикой, что PostgreSQL. */
export class MemoryRealtimeCatalog implements RealtimeCatalogPort {
  private readonly values = new Map<string, RealtimeInstrument>();

  async list(query: RealtimeCatalogQuery): Promise<RealtimeCatalogPage> {
    await Promise.resolve();
    const needle = query.query?.trim().toLowerCase();
    const all = [...this.values.values()]
      .filter((value) => !query.assetClass || value.assetClass === query.assetClass)
      .filter((value) => !query.exchange || value.exchange === query.exchange)
      .filter((value) => !query.status || value.status === query.status)
      .filter(
        (value) =>
          !needle ||
          value.id.toLowerCase().includes(needle) ||
          value.displaySymbol.toLowerCase().includes(needle),
      )
      .sort((left, right) => left.id.localeCompare(right.id));
    const items = all
      .slice(query.cursor, query.cursor + query.limit)
      .map((value) => ({ ...value }));
    return {
      items,
      nextCursor:
        query.cursor + items.length < all.length ? String(query.cursor + items.length) : null,
    };
  }

  async get(id: string): Promise<RealtimeInstrument | null> {
    await Promise.resolve();
    const value = this.values.get(id);
    return value ? { ...value } : null;
  }

  async findStreamable(): Promise<readonly RealtimeInstrument[]> {
    await Promise.resolve();
    return [...this.values.values()].filter(
      ({ status, priceEnabled }) => status === 'ACTIVE' && priceEnabled,
    );
  }

  async setPriceEnabled(id: string, enabled: boolean): Promise<RealtimeInstrument | null> {
    await Promise.resolve();
    const current = this.values.get(id);
    if (!current) return null;
    if (enabled && current.status !== 'ACTIVE') throw new Error('REALTIME_INSTRUMENT_INACTIVE');
    const updated = {
      ...current,
      priceEnabled: enabled,
      tradeEnabled: enabled ? current.tradeEnabled : false,
    };
    this.values.set(id, updated);
    return { ...updated };
  }

  async setTradeEnabled(id: string, enabled: boolean): Promise<RealtimeInstrument | null> {
    await Promise.resolve();
    const current = this.values.get(id);
    if (!current) return null;
    if (enabled && (current.status !== 'ACTIVE' || !current.priceEnabled)) return null;
    const updated = { ...current, tradeEnabled: enabled };
    this.values.set(id, updated);
    return { ...updated };
  }

  async publishSnapshot(
    assetClass: RealtimeAssetClass,
    instruments: readonly RealtimeInstrument[],
    minimumRetainedRatio: number,
  ): Promise<Readonly<{ inserted: number; updated: number; deactivated: number }>> {
    await Promise.resolve();
    const current = [...this.values.values()].filter((value) => value.assetClass === assetClass);
    if (
      instruments.length === 0 ||
      (current.length > 0 && instruments.length / current.length < minimumRetainedRatio)
    )
      throw new Error('REALTIME_CATALOG_SNAPSHOT_REJECTED');
    const ids = new Set(instruments.map(({ id }) => id));
    let inserted = 0;
    let updated = 0;
    for (const instrument of instruments) {
      const previous = this.values.get(instrument.id);
      this.values.set(instrument.id, {
        ...instrument,
        priceEnabled: previous?.priceEnabled ?? instrument.priceEnabled,
        tradeEnabled: previous?.tradeEnabled ?? instrument.tradeEnabled,
      });
      if (previous) updated += 1;
      else inserted += 1;
    }
    let deactivated = 0;
    for (const value of current) {
      if (!ids.has(value.id) && value.status !== 'INACTIVE') {
        this.values.set(value.id, {
          ...value,
          status: 'INACTIVE',
          priceEnabled: false,
          tradeEnabled: false,
        });
        deactivated += 1;
      }
    }
    return { inserted, updated, deactivated };
  }
}
