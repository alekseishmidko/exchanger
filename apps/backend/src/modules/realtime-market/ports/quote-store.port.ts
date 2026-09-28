import type { RealtimeExecution, ReferenceQuote } from '@exchange/contracts';

export const QUOTE_STORE_PORT = Symbol('QUOTE_STORE_PORT');

export interface QuoteStorePort {
  connect(): Promise<void>;
  close(): Promise<void>;
  putLatest(
    quote: Omit<ReferenceQuote, 'sequence'>,
    fenceToken?: string,
  ): Promise<ReferenceQuote | null>;
  getLatest(instrumentId: string, now?: Date): Promise<ReferenceQuote | null>;
  subscribe(listener: (quote: ReferenceQuote) => void): Promise<() => Promise<void>>;
  publishExecution(ownerId: string, execution: RealtimeExecution): Promise<void>;
  subscribeExecutions(
    listener: (ownerId: string, execution: RealtimeExecution) => void,
  ): Promise<() => Promise<void>>;
  check(): Promise<void>;
}
