import { Inject } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { RealtimeAssetClass, RealtimeInstrument } from '@exchange/contracts';
import type { Pool, PoolClient } from 'pg';
import {
  POSTGRES_POOL,
  POSTGRES_TRANSACTION,
  PostgresTransactionManager,
} from '../../../infrastructure/postgres';
import type {
  RealtimeCatalogPage,
  RealtimeCatalogPort,
  RealtimeCatalogQuery,
} from '../ports/realtime-catalog.port';

type InstrumentRow = Readonly<{
  id: string;
  display_symbol: string;
  provider_symbol: string;
  asset_class: RealtimeAssetClass;
  exchange: string | null;
  mic_code: string | null;
  base_asset_id: string;
  quote_asset_id: string;
  price_enabled: boolean;
  trade_enabled: boolean;
  status: 'ACTIVE' | 'INACTIVE';
  synced_at: Date;
}>;

/** Durable catalog adapter; публикация snapshot атомарна и сохраняет admin flags. */
export class PostgresRealtimeCatalog implements RealtimeCatalogPort {
  constructor(
    @Inject(POSTGRES_POOL) private readonly pool: Pool,
    @Inject(POSTGRES_TRANSACTION) private readonly transactions: PostgresTransactionManager,
  ) {}

  async list(query: RealtimeCatalogQuery): Promise<RealtimeCatalogPage> {
    const values: unknown[] = [];
    const clauses: string[] = [];
    if (query.assetClass) {
      values.push(query.assetClass);
      clauses.push(`asset_class=$${values.length}`);
    }
    if (query.exchange) {
      values.push(query.exchange);
      clauses.push(`exchange=$${values.length}`);
    }
    if (query.status) {
      values.push(query.status);
      clauses.push(`status=$${values.length}`);
    }
    if (query.query) {
      values.push(`%${query.query.replace(/[\\%_]/g, '\\$&')}%`);
      clauses.push(
        `(id ILIKE $${values.length} ESCAPE '\\' OR display_symbol ILIKE $${values.length} ESCAPE '\\')`,
      );
    }
    values.push(query.limit + 1, query.cursor);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const result = await this.pool.query<InstrumentRow>(
      `SELECT id, display_symbol, provider_symbol, asset_class, exchange, mic_code,
              base_asset_id, quote_asset_id, price_enabled, trade_enabled, status, synced_at
         FROM realtime_instruments ${where}
        ORDER BY id LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    const hasMore = result.rows.length > query.limit;
    const rows = result.rows.slice(0, query.limit);
    return {
      items: rows.map((row) => this.map(row)),
      nextCursor: hasMore ? String(query.cursor + rows.length) : null,
    };
  }

  async get(id: string): Promise<RealtimeInstrument | null> {
    const result = await this.pool.query<InstrumentRow>(
      `SELECT id, display_symbol, provider_symbol, asset_class, exchange, mic_code,
              base_asset_id, quote_asset_id, price_enabled, trade_enabled, status, synced_at
         FROM realtime_instruments WHERE id=$1`,
      [id],
    );
    return result.rows[0] ? this.map(result.rows[0]) : null;
  }

  async findStreamable(): Promise<readonly RealtimeInstrument[]> {
    const result = await this.pool.query<InstrumentRow>(
      `SELECT id, display_symbol, provider_symbol, asset_class, exchange, mic_code,
              base_asset_id, quote_asset_id, price_enabled, trade_enabled, status, synced_at
         FROM realtime_instruments
        WHERE status='ACTIVE' AND price_enabled=true ORDER BY id`,
    );
    return result.rows.map((row) => this.map(row));
  }

  async setPriceEnabled(id: string, enabled: boolean): Promise<RealtimeInstrument | null> {
    const result = await this.pool.query<InstrumentRow>(
      `UPDATE realtime_instruments
          SET price_enabled=$2, trade_enabled=CASE WHEN $2 THEN trade_enabled ELSE false END,
              updated_at=clock_timestamp()
        WHERE id=$1 AND ($2=false OR status='ACTIVE')
      RETURNING id, display_symbol, provider_symbol, asset_class, exchange, mic_code,
                base_asset_id, quote_asset_id, price_enabled, trade_enabled, status, synced_at`,
      [id, enabled],
    );
    return result.rows[0] ? this.map(result.rows[0]) : null;
  }

  async setTradeEnabled(id: string, enabled: boolean): Promise<RealtimeInstrument | null> {
    const result = await this.pool.query<InstrumentRow>(
      `UPDATE realtime_instruments
          SET trade_enabled=$2, updated_at=clock_timestamp()
        WHERE id=$1 AND ($2=false OR (status='ACTIVE' AND price_enabled=true))
      RETURNING id, display_symbol, provider_symbol, asset_class, exchange, mic_code,
                base_asset_id, quote_asset_id, price_enabled, trade_enabled, status, synced_at`,
      [id, enabled],
    );
    return result.rows[0] ? this.map(result.rows[0]) : null;
  }

  async publishSnapshot(
    assetClass: RealtimeAssetClass,
    instruments: readonly RealtimeInstrument[],
    minimumRetainedRatio: number,
  ): Promise<Readonly<{ inserted: number; updated: number; deactivated: number }>> {
    if (instruments.length === 0) throw new Error('REALTIME_CATALOG_SNAPSHOT_REJECTED');
    return this.transactions.run(async (client) => {
      const syncId = `stage:${randomUUID()}`;
      const count = await client.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM realtime_instruments WHERE asset_class=$1',
        [assetClass],
      );
      const current = Number(count.rows[0]?.count ?? 0);
      if (current > 0 && instruments.length / current < minimumRetainedRatio)
        throw new Error('REALTIME_CATALOG_SNAPSHOT_REJECTED');
      const existing = await client.query<{ id: string }>(
        'SELECT id FROM realtime_instruments WHERE asset_class=$1',
        [assetClass],
      );
      const existingIds = new Set(existing.rows.map(({ id }) => id));
      for (let start = 0; start < instruments.length; start += 500) {
        await this.stageChunk(client, syncId, instruments.slice(start, start + 500));
      }
      await client.query(
        `INSERT INTO realtime_instruments
          (id,provider,provider_symbol,display_symbol,asset_class,exchange,mic_code,
           base_asset_id,quote_asset_id,price_enabled,trade_enabled,status,synced_at)
         SELECT id,'TwelveData',provider_symbol,display_symbol,asset_class,exchange,mic_code,
                base_asset_id,quote_asset_id,false,false,'ACTIVE',synced_at
           FROM realtime_instrument_staging WHERE sync_id=$1
         ON CONFLICT (id) DO UPDATE SET
           provider_symbol=EXCLUDED.provider_symbol, display_symbol=EXCLUDED.display_symbol,
           asset_class=EXCLUDED.asset_class, exchange=EXCLUDED.exchange, mic_code=EXCLUDED.mic_code,
           base_asset_id=EXCLUDED.base_asset_id, quote_asset_id=EXCLUDED.quote_asset_id,
           status='ACTIVE', synced_at=EXCLUDED.synced_at, updated_at=clock_timestamp()`,
        [syncId],
      );
      const deactivated = await client.query(
        `UPDATE realtime_instruments
            SET status='INACTIVE', price_enabled=false, trade_enabled=false, updated_at=clock_timestamp()
          WHERE asset_class=$1
            AND NOT EXISTS (SELECT 1 FROM realtime_instrument_staging s WHERE s.sync_id=$2 AND s.id=realtime_instruments.id)
            AND status <> 'INACTIVE'`,
        [assetClass, syncId],
      );
      await client.query('DELETE FROM realtime_instrument_staging WHERE sync_id=$1', [syncId]);
      return {
        inserted: instruments.filter(({ id }) => !existingIds.has(id)).length,
        updated: instruments.filter(({ id }) => existingIds.has(id)).length,
        deactivated: deactivated.rowCount ?? 0,
      };
    });
  }

  private async stageChunk(
    client: PoolClient,
    syncId: string,
    items: readonly RealtimeInstrument[],
  ): Promise<void> {
    await client.query(
      `INSERT INTO realtime_instrument_staging
         (sync_id,id,provider_symbol,display_symbol,asset_class,exchange,mic_code,
          base_asset_id,quote_asset_id,synced_at)
       SELECT * FROM UNNEST(
         $1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[],
         $7::text[], $8::text[], $9::text[], $10::timestamptz[])`,
      [
        items.map(() => syncId),
        items.map(({ id }) => id),
        items.map(({ providerSymbol }) => providerSymbol),
        items.map(({ displaySymbol }) => displaySymbol),
        items.map(({ assetClass }) => assetClass),
        items.map(({ exchange }) => exchange),
        items.map(({ micCode }) => micCode),
        items.map(({ baseAssetId }) => baseAssetId),
        items.map(({ quoteAssetId }) => quoteAssetId),
        items.map(({ syncedAt }) => syncedAt),
      ],
    );
  }

  private map(row: InstrumentRow): RealtimeInstrument {
    return {
      id: row.id,
      displaySymbol: row.display_symbol,
      providerSymbol: row.provider_symbol,
      assetClass: row.asset_class,
      exchange: row.exchange,
      micCode: row.mic_code,
      baseAssetId: row.base_asset_id,
      quoteAssetId: row.quote_asset_id,
      priceEnabled: row.price_enabled,
      tradeEnabled: row.trade_enabled,
      status: row.status,
      source: 'TwelveData',
      syncedAt: row.synced_at.toISOString(),
    };
  }
}
