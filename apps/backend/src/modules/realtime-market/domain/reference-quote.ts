import { createHash } from 'node:crypto';
import { referenceQuoteSchema, type ReferenceQuote } from '@exchange/contracts';
import { Decimal } from '../../shared-kernel';

export type ProviderPriceTick = Readonly<{
  instrumentId: string;
  price: string;
  providerTimestamp: Date;
  receivedAt: Date;
}>;

/** Строит immutable quote и отклоняет нулевые, отрицательные и будущие ticks. */
export function createReferenceQuote(
  tick: ProviderPriceTick,
  sequence: bigint,
  maxAgeMs: number,
  now: Date = tick.receivedAt,
): ReferenceQuote {
  const price = Decimal.from(tick.price);
  if (price.compare(Decimal.from('0')) <= 0) throw new Error('REALTIME_PRICE_INVALID');
  if (tick.providerTimestamp.getTime() > now.getTime() + 5_000)
    throw new Error('REALTIME_TIMESTAMP_FUTURE');
  const receivedAt = tick.receivedAt.toISOString();
  const providerTimestamp = tick.providerTimestamp.toISOString();
  const quoteId = `q:${createHash('sha256')
    .update(`${tick.instrumentId}|${tick.price}|${providerTimestamp}|${receivedAt}`)
    .digest('hex')
    .slice(0, 32)}`;
  const expiresAt = new Date(tick.receivedAt.getTime() + maxAgeMs).toISOString();
  return referenceQuoteSchema.parse({
    instrumentId: tick.instrumentId,
    quoteId,
    price: price.toString(),
    priceType: 'LAST',
    providerTimestamp,
    receivedAt,
    expiresAt,
    sequence: sequence.toString(),
    status: now.toISOString() < expiresAt ? 'FRESH' : 'STALE',
    source: 'TwelveData',
  });
}

/** Возвращает detached quote с актуальным freshness status. */
export function evaluateQuote(quote: ReferenceQuote, now: Date): ReferenceQuote {
  return {
    ...quote,
    status: now.getTime() < Date.parse(quote.expiresAt) ? 'FRESH' : 'STALE',
  };
}
