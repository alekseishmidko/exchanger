import { randomUUID } from 'node:crypto';
import { Inject, Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { RealtimeAssetClass } from '@exchange/contracts';
import type { Pool } from 'pg';
import { POSTGRES_POOL } from '../../../infrastructure/postgres';
import {
  REFERENCE_DATA_PROVIDER,
  type ReferenceDataProviderPort,
} from '../ports/reference-data-provider.port';
import { REALTIME_CATALOG_PORT, type RealtimeCatalogPort } from '../ports/realtime-catalog.port';
import { RealtimeMarketStatusService } from './realtime-market-status.service';

/** Периодически публикует defensive catalog snapshots без overlap запусков. */
@Injectable()
export class ReferenceDataSyncService implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;

  constructor(
    private readonly config: ConfigService,
    @Inject(REFERENCE_DATA_PROVIDER) private readonly provider: ReferenceDataProviderPort,
    @Inject(REALTIME_CATALOG_PORT) private readonly catalog: RealtimeCatalogPort,
    @Inject(POSTGRES_POOL) private readonly pool: Pool,
    private readonly status: RealtimeMarketStatusService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.enabled()) return;
    if (this.config.get('TWELVE_DATA_CATALOG_SYNC_ON_START', 'true') === 'true') void this.sync();
    const interval = Number(this.config.get('TWELVE_DATA_CATALOG_SYNC_INTERVAL_MS', '86400000'));
    this.timer = setInterval(() => void this.sync(), interval);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  sync(): Promise<void> {
    if (!this.enabled()) return Promise.resolve();
    if (!this.running)
      this.running = this.run().finally(() => {
        delete this.running;
      });
    return this.running;
  }

  private async run(): Promise<void> {
    for (const assetClass of this.assetClasses()) {
      const id = `catalog-sync:${randomUUID()}`;
      await this.recordStart(id, assetClass);
      try {
        const now = new Date();
        const instruments = await this.provider.loadCatalog(assetClass, now);
        const result = await this.catalog.publishSnapshot(
          assetClass,
          instruments,
          Number(this.config.get('TWELVE_DATA_CATALOG_MIN_RETAINED_RATIO', '0.5')),
        );
        await this.recordSuccess(id, instruments.length, result);
        this.status.markCatalogSync(now);
      } catch (error) {
        await this.recordFailure(id, this.errorCode(error));
      }
    }
  }

  private assetClasses(): readonly RealtimeAssetClass[] {
    return this.config
      .get<string>('TWELVE_DATA_ASSET_CLASSES', 'crypto,forex')
      .split(',')
      .map((value) => value.trim().toUpperCase() as RealtimeAssetClass);
  }
  private enabled(): boolean {
    return ['true', '1'].includes(this.config.get('TWELVE_DATA_ENABLED', 'false'));
  }
  private durable(): boolean {
    return this.config.get('RUNTIME_PROFILE') !== 'component';
  }

  private async recordStart(id: string, assetClass: RealtimeAssetClass): Promise<void> {
    if (!this.durable()) return;
    await this.pool.query(
      "INSERT INTO realtime_catalog_sync_runs(id, asset_class, status) VALUES ($1,$2,'RUNNING')",
      [id, assetClass],
    );
  }
  private async recordSuccess(
    id: string,
    received: number,
    result: Readonly<{ inserted: number; updated: number; deactivated: number }>,
  ): Promise<void> {
    if (!this.durable()) return;
    await this.pool.query(
      `UPDATE realtime_catalog_sync_runs SET status='SUCCEEDED', received_count=$2, inserted_count=$3, updated_count=$4, deactivated_count=$5, completed_at=clock_timestamp() WHERE id=$1`,
      [id, received, result.inserted, result.updated, result.deactivated],
    );
  }
  private async recordFailure(id: string, code: string): Promise<void> {
    if (!this.durable()) return;
    await this.pool.query(
      `UPDATE realtime_catalog_sync_runs SET status='FAILED', error_code=$2, completed_at=clock_timestamp() WHERE id=$1`,
      [id, code],
    );
  }
  private errorCode(error: unknown): string {
    return error instanceof Error && /^[A-Z0-9_]{1,64}$/.test(error.message)
      ? error.message
      : 'TWELVE_DATA_CATALOG_SYNC_FAILED';
  }
}
