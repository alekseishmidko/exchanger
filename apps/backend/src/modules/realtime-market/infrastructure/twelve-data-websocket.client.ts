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

export type TwelveDataPriceEvent = z.infer<typeof priceEventSchema>;

export function parseTwelveDataPriceEvent(input: string): TwelveDataPriceEvent | null {
  try {
    const parsed = priceEventSchema.safeParse(JSON.parse(input));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Minimal plain-WebSocket adapter с bounded messages и без логирования URL/key. */
export class TwelveDataWebSocketClient {
  private socket: WebSocket | undefined;
  private heartbeat: NodeJS.Timeout | undefined;

  constructor(
    private readonly endpoint: string,
    private readonly apiKey: string,
    private readonly heartbeatMs: number,
    private readonly onPrice: (event: TwelveDataPriceEvent) => Promise<void>,
    private readonly onClosed: () => void,
    private readonly onInvalid: () => void,
  ) {}

  connect(symbols: readonly string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = new URL(this.endpoint);
      url.searchParams.set('apikey', this.apiKey);
      const socket = new WebSocket(url, { maxPayload: 64 * 1024, handshakeTimeout: 10_000 });
      this.socket = socket;
      const fail = (error: Error): void =>
        reject(
          new Error(
            error.message ? 'TWELVE_DATA_WS_CONNECT_FAILED' : 'TWELVE_DATA_WS_CONNECT_FAILED',
          ),
        );
      socket.once('error', fail);
      socket.once('open', () => {
        socket.off('error', fail);
        socket.on('error', () => undefined);
        socket.send(
          JSON.stringify({ action: 'subscribe', params: { symbols: symbols.join(',') } }),
        );
        this.heartbeat = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN)
            socket.send(JSON.stringify({ action: 'heartbeat' }));
        }, this.heartbeatMs);
        this.heartbeat.unref();
        resolve();
      });
      socket.on('message', (raw) => {
        const text = this.messageText(raw);
        if (Buffer.byteLength(text) > 64 * 1024) return;
        const parsed = parseTwelveDataPriceEvent(text);
        if (parsed) void this.onPrice(parsed).catch(() => this.onInvalid());
        else this.onInvalid();
      });
      socket.once('close', () => {
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
