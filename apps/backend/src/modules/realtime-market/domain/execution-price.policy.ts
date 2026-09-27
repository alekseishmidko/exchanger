import type { ReferenceQuote } from '@exchange/contracts';
import { evaluateQuote } from './reference-quote';

/** Stage-1 policy contract; execution integration remains isolated until stage 5. */
export class ExactLastExecutionPricePolicy {
  resolve(
    quote: ReferenceQuote | null,
    expectedQuoteId: string,
    now: Date,
  ): Readonly<{ price: string; quote: ReferenceQuote }> {
    if (!quote) throw new Error('REALTIME_PRICE_UNAVAILABLE');
    const current = evaluateQuote(quote, now);
    if (current.status !== 'FRESH') throw new Error('QUOTE_STALE');
    if (current.quoteId !== expectedQuoteId) throw new Error('QUOTE_CHANGED');
    return { price: current.price, quote: current };
  }
}
