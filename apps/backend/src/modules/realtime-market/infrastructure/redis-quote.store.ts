import { createClient, type RedisClientType } from 'redis';
import {
  realtimeExecutionSchema,
  referenceQuoteSchema,
  type RealtimeExecution,
  type ReferenceQuote,
} from '@exchange/contracts';
import { z } from 'zod';
import { evaluateQuote } from '../domain/reference-quote';
import type { QuoteStorePort } from '../ports/quote-store.port';

const PUT_LATEST = `
if ARGV[3] ~= '' and redis.call('GET', KEYS[4]) ~= ARGV[3] then return false end
local current = redis.call('GET', KEYS[1])
local incoming = cjson.decode(ARGV[1])
if current then
  local previous = cjson.decode(current)
  if previous.providerTimestamp > incoming.providerTimestamp or previous.quoteId == incoming.quoteId or
     (previous.providerTimestamp == incoming.providerTimestamp and previous.price == incoming.price) then
    return false
  end
end
local sequence = redis.call('INCR', KEYS[2])
incoming.sequence = tostring(sequence)
local encoded = cjson.encode(incoming)
redis.call('SET', KEYS[1], encoded, 'PX', ARGV[2])
redis.call('PUBLISH', KEYS[3], encoded)
return encoded
`;
const executionEventSchema = z
  .object({ ownerId: z.string().min(1).max(128), execution: realtimeExecutionSchema })
  .strict();

/** Shared hot cache; Lua связывает ordering, latest update, TTL и publication. */
export class RedisQuoteStore implements QuoteStorePort {
  private readonly client: RedisClientType;
  private readonly subscriber: RedisClientType;

  constructor(
    url: string,
    private readonly ttlMs: number,
  ) {
    this.client = createClient({
      url,
      disableOfflineQueue: true,
      socket: { reconnectStrategy: false },
    });
    this.subscriber = createClient({
      url,
      disableOfflineQueue: true,
      socket: { reconnectStrategy: false },
    });
    this.client.on('error', () => undefined);
    this.subscriber.on('error', () => undefined);
  }

  async connect(): Promise<void> {
    if (!this.client.isOpen) await this.client.connect();
  }

  async close(): Promise<void> {
    if (this.subscriber.isOpen) await this.subscriber.quit();
    if (this.client.isOpen) await this.client.quit();
  }

  async putLatest(
    quote: Omit<ReferenceQuote, 'sequence'>,
    fenceToken?: string,
  ): Promise<ReferenceQuote | null> {
    const result = await this.client.eval(PUT_LATEST, {
      keys: [
        this.quoteKey(quote.instrumentId),
        this.sequenceKey(quote.instrumentId),
        'realtime:quote-events:v1',
        'realtime:ingest-leader:v1',
      ],
      arguments: [JSON.stringify(quote), String(this.ttlMs), fenceToken ?? ''],
    });
    return typeof result === 'string' ? referenceQuoteSchema.parse(JSON.parse(result)) : null;
  }

  async getLatest(instrumentId: string, now = new Date()): Promise<ReferenceQuote | null> {
    const raw = await this.client.get(this.quoteKey(instrumentId));
    return raw ? evaluateQuote(referenceQuoteSchema.parse(JSON.parse(raw)), now) : null;
  }

  async check(): Promise<void> {
    if ((await this.client.ping()) !== 'PONG') throw new Error('REALTIME_QUOTE_STORE_UNAVAILABLE');
  }

  async subscribe(listener: (quote: ReferenceQuote) => void): Promise<() => Promise<void>> {
    if (!this.subscriber.isOpen) await this.subscriber.connect();
    const channel = 'realtime:quote-events:v1';
    await this.subscriber.subscribe(channel, (raw) => {
      try {
        const parsed = referenceQuoteSchema.safeParse(JSON.parse(raw));
        if (parsed.success) listener(parsed.data);
      } catch {
        return;
      }
    });
    return async () => {
      if (this.subscriber.isOpen) await this.subscriber.unsubscribe(channel);
    };
  }

  async publishExecution(ownerId: string, execution: RealtimeExecution): Promise<void> {
    await this.client.publish(
      'realtime:execution-events:v1',
      JSON.stringify({ ownerId, execution }),
    );
  }

  async subscribeExecutions(
    listener: (ownerId: string, execution: RealtimeExecution) => void,
  ): Promise<() => Promise<void>> {
    if (!this.subscriber.isOpen) await this.subscriber.connect();
    const channel = 'realtime:execution-events:v1';
    await this.subscriber.subscribe(channel, (raw) => {
      try {
        const parsed = executionEventSchema.safeParse(JSON.parse(raw));
        if (parsed.success) listener(parsed.data.ownerId, parsed.data.execution);
      } catch {
        return;
      }
    });
    return async () => {
      if (this.subscriber.isOpen) await this.subscriber.unsubscribe(channel);
    };
  }

  private quoteKey(instrumentId: string): string {
    return `realtime:quote:v1:${instrumentId}`;
  }
  private sequenceKey(instrumentId: string): string {
    return `realtime:quote-seq:v1:${instrumentId}`;
  }
}
