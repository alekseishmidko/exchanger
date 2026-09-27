import { Injectable } from '@nestjs/common';
import { MetricsService } from '../../observability';

export type RealtimeProviderState =
  'DISABLED' | 'FOLLOWER' | 'CONNECTING' | 'CONNECTED' | 'DEGRADED';
export type RealtimeMarketStatusSnapshot = Readonly<{
  state: RealtimeProviderState;
  lastMessageAt: string | null;
  lastCatalogSyncAt: string | null;
  reconnects: number;
}>;

@Injectable()
export class RealtimeMarketStatusService {
  private state: RealtimeProviderState = 'DISABLED';
  private lastMessageAt: string | null = null;
  private lastCatalogSyncAt: string | null = null;
  private reconnects = 0;
  private readonly listeners = new Set<(snapshot: RealtimeMarketStatusSnapshot) => void>();

  constructor(private readonly metrics: MetricsService) {
    this.metrics.setRealtimeProviderState('DISABLED');
  }

  setState(state: RealtimeProviderState): void {
    this.state = state;
    this.metrics.setRealtimeProviderState(state);
    this.publish();
  }
  markMessage(at: Date): void {
    this.lastMessageAt = at.toISOString();
  }
  markCatalogSync(at: Date): void {
    this.lastCatalogSyncAt = at.toISOString();
    this.publish();
  }
  markReconnect(): void {
    this.reconnects += 1;
    this.publish();
  }
  subscribe(listener: (snapshot: RealtimeMarketStatusSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  snapshot(): RealtimeMarketStatusSnapshot {
    return {
      state: this.state,
      lastMessageAt: this.lastMessageAt,
      lastCatalogSyncAt: this.lastCatalogSyncAt,
      reconnects: this.reconnects,
    };
  }

  private publish(): void {
    const value = this.snapshot();
    for (const listener of this.listeners) listener(value);
  }
}
