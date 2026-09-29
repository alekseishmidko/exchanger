import { Inject, Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { RealtimeInstrument } from '@exchange/contracts';
import { MetricsService } from '../../observability';
import { createReferenceQuote } from '../domain/reference-quote';
import { RedisIngestLease } from '../infrastructure/redis-ingest-lease';
import {
  TwelveDataWebSocketClient,
  type TwelveDataPriceEvent,
} from '../infrastructure/twelve-data-websocket.client';
import { QUOTE_STORE_PORT, type QuoteStorePort } from '../ports/quote-store.port';
import { REALTIME_CATALOG_PORT, type RealtimeCatalogPort } from '../ports/realtime-catalog.port';
import {
  REFERENCE_DATA_PROVIDER,
  type ReferenceDataProviderPort,
} from '../ports/reference-data-provider.port';
import { RealtimeMarketStatusService } from './realtime-market-status.service';

/** Управляет single-owner connection, mapping ticks, reconnect и Redis publication. */
@Injectable()
export class PriceStreamSupervisor implements OnApplicationBootstrap, OnApplicationShutdown {
  private stopped = false;
  private lease?: RedisIngestLease;
  private client?: TwelveDataWebSocketClient;
  private renewal?: NodeJS.Timeout;
  private reconnect: NodeJS.Timeout | undefined;
  private instruments = new Map<string, RealtimeInstrument>();
  private attempt = 0;
  private leader = false;

  constructor(
    private readonly config: ConfigService,
    @Inject(REALTIME_CATALOG_PORT) private readonly catalog: RealtimeCatalogPort,
    @Inject(QUOTE_STORE_PORT) private readonly quotes: QuoteStorePort,
    @Inject(REFERENCE_DATA_PROVIDER) private readonly referenceData: ReferenceDataProviderPort,
    private readonly status: RealtimeMarketStatusService,
    private readonly metrics: MetricsService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.enabled()) return;
    await this.quotes.connect();
    const leaseTtl = Number(this.config.get('TWELVE_DATA_LEADER_TTL_MS', '15000'));
    this.lease = new RedisIngestLease(this.config.getOrThrow('TWELVE_DATA_REDIS_URL'), leaseTtl);
    await this.lease.connect();
    await this.maintainLease();
    this.renewal = setInterval(
      () => void this.maintainLease(),
      Math.max(1000, Math.floor(leaseTtl / 3)),
    );
    this.renewal.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.renewal) clearInterval(this.renewal);
    if (this.reconnect) clearTimeout(this.reconnect);
    this.client?.close();
    await this.lease?.close();
    await this.quotes.close();
  }

  private async open(): Promise<void> {
    const streamable = await this.catalog.findStreamable();
    this.instruments = this.buildLookup(streamable);
    const maxSymbols = Number(this.config.get('TWELVE_DATA_MAX_SYMBOLS', '100'));
    if (streamable.length === 0 || streamable.length > maxSymbols) {
      this.status.setState('DEGRADED');
      this.scheduleReconnect();
      return;
    }
    this.status.setState('CONNECTING');
    this.client = new TwelveDataWebSocketClient(
      this.config.getOrThrow('TWELVE_DATA_WS_URL'),
      this.config.getOrThrow('TWELVE_DATA_API_KEY'),
      Number(this.config.get('TWELVE_DATA_HEARTBEAT_MS', '10000')),
      Number(this.config.get('TWELVE_DATA_SUBSCRIBE_ACK_TIMEOUT_MS', '10000')),
      (event) => this.accept(event),
      () => this.scheduleReconnect(),
      () => this.metrics.observeRealtimeTick('invalid'),
    );
    try {
      await this.client.connect(
        streamable.map((item) =>
          item.exchange ? `${item.providerSymbol}:${item.exchange}` : item.providerSymbol,
        ),
      );
      this.attempt = 0;
      this.status.setState('CONNECTED');
      void this.bootstrapQuotes(streamable);
    } catch {
      this.scheduleReconnect();
    }
  }

  /** Ограниченный REST bootstrap; он не вызывается из пользовательского request path. */
  private async bootstrapQuotes(instruments: readonly RealtimeInstrument[]): Promise<void> {
    const limit = Number(this.config.get('TWELVE_DATA_REST_BOOTSTRAP_LIMIT', '10'));
    await Promise.all(
      instruments.slice(0, limit).map(async (instrument) => {
        try {
          const quote = await this.referenceData.loadQuote(instrument);
          const receivedAt = new Date();
          const draft = createReferenceQuote(
            { instrumentId: instrument.id, ...quote, receivedAt },
            1n,
            Number(this.config.get('TWELVE_DATA_QUOTE_MAX_AGE_MS', '5000')),
          );
          const { sequence, ...withoutSequence } = draft;
          void sequence;
          const stored = await this.quotes.putLatest(withoutSequence, this.lease?.fenceToken());
          this.metrics.observeRealtimeTick(stored ? 'accepted' : 'duplicate');
          if (stored) this.status.markMessage(receivedAt);
        } catch {
          this.metrics.observeRealtimeTick('invalid');
        }
      }),
    );
  }

  private async accept(event: TwelveDataPriceEvent): Promise<void> {
    const instrument = this.resolve(event);
    if (!instrument) return;
    const receivedAt = new Date();
    const draft = createReferenceQuote(
      {
        instrumentId: instrument.id,
        price: String(event.price),
        providerTimestamp: new Date(event.timestamp * 1000),
        receivedAt,
      },
      1n,
      Number(this.config.get('TWELVE_DATA_QUOTE_MAX_AGE_MS', '5000')),
    );
    const { sequence, ...withoutSequence } = draft;
    void sequence;
    const stored = await this.quotes.putLatest(withoutSequence, this.lease?.fenceToken());
    this.metrics.observeRealtimeTick(stored ? 'accepted' : 'duplicate');
    if (stored) this.status.markMessage(receivedAt);
  }

  private resolve(event: TwelveDataPriceEvent): RealtimeInstrument | undefined {
    return (
      this.instruments.get(`${event.symbol}|${event.exchange ?? ''}`) ??
      this.instruments.get(`${event.symbol}|`)
    );
  }

  private buildLookup(values: readonly RealtimeInstrument[]): Map<string, RealtimeInstrument> {
    const result = new Map<string, RealtimeInstrument>();
    const counts = new Map<string, number>();
    for (const value of values)
      counts.set(value.providerSymbol, (counts.get(value.providerSymbol) ?? 0) + 1);
    for (const value of values) {
      result.set(`${value.providerSymbol}|${value.exchange ?? ''}`, value);
      if (counts.get(value.providerSymbol) === 1) result.set(`${value.providerSymbol}|`, value);
    }
    return result;
  }

  private async maintainLease(): Promise<void> {
    if (!this.lease) return;
    if (!this.leader) {
      if (await this.lease.acquire().catch(() => false)) {
        this.leader = true;
        await this.open();
      } else this.status.setState('FOLLOWER');
      return;
    }
    if (!(await this.lease.renew().catch(() => false))) {
      this.leader = false;
      this.client?.close();
      this.status.setState('FOLLOWER');
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || !this.leader || this.reconnect) return;
    this.status.markReconnect();
    this.status.setState('DEGRADED');
    const min = Number(this.config.get('TWELVE_DATA_RECONNECT_MIN_MS', '1000'));
    const max = Number(this.config.get('TWELVE_DATA_RECONNECT_MAX_MS', '30000'));
    const delay = Math.min(max, min * 2 ** Math.min(this.attempt++, 10));
    this.reconnect = setTimeout(
      () => {
        this.reconnect = undefined;
        void this.open();
      },
      delay + Math.floor(Math.random() * Math.max(1, delay / 4)),
    );
    this.reconnect.unref();
  }

  private enabled(): boolean {
    return ['true', '1'].includes(this.config.get('TWELVE_DATA_ENABLED', 'false'));
  }
}
