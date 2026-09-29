import WebSocket from 'ws';
import { z } from 'zod';

const priceEventSchema = z
  .object({
    event: z.literal('price'),
    symbol: z.string().min(1).max(64),
    exchange: z.string().min(1).max(128).optional(),
    price: z.union([z.string(), z.number()]),
    timestamp: z.number().int().positive(),
  })
  .passthrough();
const subscriptionItemSchema = z
  .object({
    symbol: z.string().min(1).max(64),
    exchange: z.string().max(128).optional(),
  })
  .passthrough();
const subscriptionStatusSchema = z
  .object({
    event: z.literal('subscribe-status'),
    status: z.string().min(1).max(32),
    success: z.array(subscriptionItemSchema).nullable().optional(),
    fails: z.array(subscriptionItemSchema).nullable().optional(),
  })
  .passthrough();
const heartbeatEventSchema = z
  .object({ event: z.literal('heartbeat'), status: z.string().max(32).optional() })
  .passthrough();

export type TwelveDataPriceEvent = z.infer<typeof priceEventSchema>;

export type TwelveDataServerEvent =
  | Readonly<{ type: 'price'; value: TwelveDataPriceEvent }>
  | Readonly<{
      type: 'subscription';
      status: string;
      successful: readonly z.infer<typeof subscriptionItemSchema>[];
      failed: readonly z.infer<typeof subscriptionItemSchema>[];
    }>
  | Readonly<{ type: 'heartbeat' }>;

/** Разбирает только известные bounded server events, не смешивая control и price traffic. */
export function parseTwelveDataServerEvent(input: string): TwelveDataServerEvent | null {
  try {
    const value: unknown = JSON.parse(input);
    const price = priceEventSchema.safeParse(value);
    if (price.success) return { type: 'price', value: price.data };
    const subscription = subscriptionStatusSchema.safeParse(value);
    if (subscription.success)
      return {
        type: 'subscription',
        status: subscription.data.status,
        successful: subscription.data.success ?? [],
        failed: subscription.data.fails ?? [],
      };
    if (heartbeatEventSchema.safeParse(value).success) return { type: 'heartbeat' };
    return null;
  } catch {
    return null;
  }
}

export function parseTwelveDataPriceEvent(input: string): TwelveDataPriceEvent | null {
  const parsed = parseTwelveDataServerEvent(input);
  return parsed?.type === 'price' ? parsed.value : null;
}

/** Minimal plain-WebSocket adapter с bounded messages и без логирования URL/key. */
export class TwelveDataWebSocketClient {
  private socket: WebSocket | undefined;
  private heartbeat: NodeJS.Timeout | undefined;

  constructor(
    private readonly endpoint: string,
    private readonly apiKey: string,
    private readonly heartbeatMs: number,
    private readonly subscriptionAckTimeoutMs: number,
    private readonly onPrice: (event: TwelveDataPriceEvent) => Promise<void>,
    private readonly onClosed: () => void,
    private readonly onInvalid: () => void,
  ) {}

  connect(symbols: readonly string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const expectedSubscriptionCount = new Set(symbols).size;
      const url = new URL(this.endpoint);
      url.searchParams.set('apikey', this.apiKey);
      const socket = new WebSocket(url, { maxPayload: 64 * 1024, handshakeTimeout: 10_000 });
      this.socket = socket;
      let settled = false;
      let acknowledgement: NodeJS.Timeout | undefined;
      const fail = (code: string): void => {
        if (settled) return;
        settled = true;
        if (acknowledgement) clearTimeout(acknowledgement);
        reject(new Error(code));
      };
      socket.on('error', () => fail('TWELVE_DATA_WS_CONNECT_FAILED'));
      socket.once('open', () => {
        socket.send(
          JSON.stringify({ action: 'subscribe', params: { symbols: symbols.join(',') } }),
        );
        acknowledgement = setTimeout(() => {
          fail('TWELVE_DATA_WS_SUBSCRIPTION_TIMEOUT');
          socket.close();
        }, this.subscriptionAckTimeoutMs);
        acknowledgement.unref();
        this.heartbeat = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN)
            socket.send(JSON.stringify({ action: 'heartbeat' }));
        }, this.heartbeatMs);
        this.heartbeat.unref();
      });
      socket.on('message', (raw) => {
        const text = this.messageText(raw);
        if (Buffer.byteLength(text) > 64 * 1024) return;
        const parsed = parseTwelveDataServerEvent(text);
        if (!parsed) {
          this.onInvalid();
          return;
        }
        if (parsed.type === 'heartbeat') return;
        if (parsed.type === 'subscription') {
          if (
            parsed.status !== 'ok' ||
            parsed.failed.length > 0 ||
            parsed.successful.length !== expectedSubscriptionCount
          ) {
            fail('TWELVE_DATA_WS_SUBSCRIPTION_REJECTED');
            socket.close();
            return;
          }
          if (!settled) {
            settled = true;
            if (acknowledgement) clearTimeout(acknowledgement);
            resolve();
          }
          return;
        }
        void this.onPrice(parsed.value).catch(() => this.onInvalid());
      });
      socket.once('close', () => {
        fail('TWELVE_DATA_WS_CLOSED_BEFORE_SUBSCRIPTION');
        this.stopHeartbeat();
        this.onClosed();
      });
    });
  }

  close(): void {
    this.stopHeartbeat();
    this.socket?.close();
    this.socket = undefined;
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  private messageText(raw: WebSocket.RawData): string {
    if (Buffer.isBuffer(raw)) return raw.toString('utf8');
    if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
    return Buffer.concat(raw).toString('utf8');
  }
}
