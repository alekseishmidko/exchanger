import type { RealtimeExecution, ReferenceQuote } from '@exchange/contracts';
import { evaluateQuote } from '../domain/reference-quote';
import type { QuoteStorePort } from '../ports/quote-store.port';

export class MemoryQuoteStore implements QuoteStorePort {
  private readonly quotes = new Map<string, ReferenceQuote>();
  private readonly sequences = new Map<string, bigint>();
  private readonly listeners = new Set<(quote: ReferenceQuote) => void>();
  private readonly executionListeners = new Set<
    (ownerId: string, execution: RealtimeExecution) => void
  >();
  async connect(): Promise<void> {
    await Promise.resolve();
  }
  async close(): Promise<void> {
    await Promise.resolve();
  }
  async check(): Promise<void> {
    await Promise.resolve();
  }

  async putLatest(quote: Omit<ReferenceQuote, 'sequence'>): Promise<ReferenceQuote | null> {
    await Promise.resolve();
    const previous = this.quotes.get(quote.instrumentId);
    if (previous && Date.parse(previous.providerTimestamp) > Date.parse(quote.providerTimestamp))
      return null;
    if (
      previous?.quoteId === quote.quoteId ||
      (previous?.providerTimestamp === quote.providerTimestamp && previous.price === quote.price)
    )
      return null;
    const sequence = (this.sequences.get(quote.instrumentId) ?? 0n) + 1n;
    this.sequences.set(quote.instrumentId, sequence);
    const stored = { ...quote, sequence: sequence.toString() };
    this.quotes.set(quote.instrumentId, stored);
    for (const listener of this.listeners) listener({ ...stored });
    return { ...stored };
  }

  async getLatest(instrumentId: string, now = new Date()): Promise<ReferenceQuote | null> {
    await Promise.resolve();
    const quote = this.quotes.get(instrumentId);
    return quote ? evaluateQuote({ ...quote }, now) : null;
  }

  async subscribe(listener: (quote: ReferenceQuote) => void): Promise<() => Promise<void>> {
    await Promise.resolve();
    this.listeners.add(listener);
    return async () => {
      this.listeners.delete(listener);
      await Promise.resolve();
    };
  }

  async publishExecution(ownerId: string, execution: RealtimeExecution): Promise<void> {
    for (const listener of this.executionListeners) listener(ownerId, { ...execution });
    await Promise.resolve();
  }

  async subscribeExecutions(
    listener: (ownerId: string, execution: RealtimeExecution) => void,
  ): Promise<() => Promise<void>> {
    await Promise.resolve();
    this.executionListeners.add(listener);
    return async () => {
      this.executionListeners.delete(listener);
      await Promise.resolve();
    };
  }
}
