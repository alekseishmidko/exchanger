import { Inject, Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import type { RealtimeExecution, ReferenceQuote } from '@exchange/contracts';
import { QUOTE_STORE_PORT, type QuoteStorePort } from '../ports/quote-store.port';
import {
  RealtimeMarketStatusService,
  type RealtimeMarketStatusSnapshot,
} from './realtime-market-status.service';

@Injectable()
export class RealtimeMarketHub implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly quotes = new Map<string, Set<(quote: ReferenceQuote) => void>>();
  private readonly executions = new Map<string, Set<(value: RealtimeExecution) => void>>();
  private readonly statuses = new Set<(value: RealtimeMarketStatusSnapshot) => void>();
  private stopQuotes?: () => Promise<void>;
  private stopExecutions?: () => Promise<void>;
  private stopStatus?: () => void;

  constructor(
    @Inject(QUOTE_STORE_PORT) private readonly store: QuoteStorePort,
    private readonly status: RealtimeMarketStatusService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.stopStatus = this.status.subscribe((value) => {
      for (const listener of this.statuses) listener(value);
    });
    this.stopQuotes = await this.store.subscribe((quote) => {
      for (const listener of this.quotes.get(quote.instrumentId) ?? []) listener(quote);
    });
    this.stopExecutions = await this.store.subscribeExecutions((ownerId, execution) => {
      for (const listener of this.executions.get(ownerId) ?? []) listener(execution);
    });
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopStatus?.();
    await this.stopQuotes?.();
    await this.stopExecutions?.();
  }

  subscribeQuote(instrumentId: string, listener: (quote: ReferenceQuote) => void): () => void {
    const values = this.quotes.get(instrumentId) ?? new Set();
    values.add(listener);
    this.quotes.set(instrumentId, values);
    return () => {
      values.delete(listener);
      if (values.size === 0) this.quotes.delete(instrumentId);
    };
  }

  subscribeExecution(userId: string, listener: (value: RealtimeExecution) => void): () => void {
    const values = this.executions.get(userId) ?? new Set();
    values.add(listener);
    this.executions.set(userId, values);
    return () => {
      values.delete(listener);
      if (values.size === 0) this.executions.delete(userId);
    };
  }

  publishExecution(userId: string, value: RealtimeExecution): Promise<void> {
    return this.store.publishExecution(userId, value);
  }

  subscribeStatus(listener: (value: RealtimeMarketStatusSnapshot) => void): () => void {
    this.statuses.add(listener);
    return () => this.statuses.delete(listener);
  }
}
