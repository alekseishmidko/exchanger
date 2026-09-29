import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import WebSocket from 'ws';
import { z } from 'zod';

const restEndpoints = [
  '/quote',
  '/price',
  '/time_series',
  '/eod',
  '/exchange_rate',
  '/cryptocurrencies',
  '/forex_pairs',
  '/stocks',
  '/commodities',
  '/symbol_search',
  '/technical_indicators',
] as const;

const requestSchema = z
  .object({
    transport: z.enum(['REST', 'WEBSOCKET']),
    endpoint: z.enum(restEndpoints).optional(),
    symbol: z.string().trim().min(1).max(64).optional(),
    exchange: z.string().trim().min(1).max(128).optional(),
    interval: z
      .enum(['1min', '5min', '15min', '30min', '45min', '1h', '2h', '4h', '8h', '1day'])
      .optional(),
    outputsize: z.number().int().min(1).max(100).optional(),
    page: z.number().int().min(1).max(1000).optional(),
  })
  .strict();

export type TwelveDataDiagnosticRequest = z.infer<typeof requestSchema>;

export type TwelveDataDiagnosticResult = Readonly<{
  provider: 'TwelveData';
  transport: 'REST' | 'WEBSOCKET';
  endpoint: string;
  request: Readonly<Record<string, string | number>>;
  durationMs: number;
  httpStatus?: number;
  credits?: Readonly<{ used: string | null; left: string | null }>;
  events?: readonly unknown[];
  body?: unknown;
  timedOut?: boolean;
}>;

const requiresSymbol = new Set([
  '/quote',
  '/price',
  '/time_series',
  '/eod',
  '/exchange_rate',
  '/symbol_search',
]);
const supportsExchange = new Set(['/quote', '/price', '/time_series', '/eod', '/stocks']);
const supportsOutputsize = new Set([
  '/time_series',
  '/cryptocurrencies',
  '/forex_pairs',
  '/stocks',
  '/commodities',
  '/symbol_search',
]);
const supportsPage = new Set(['/cryptocurrencies', '/forex_pairs', '/stocks', '/commodities']);

/** Admin-only bounded provider inspector. It is deliberately not a generic HTTP proxy. */
@Injectable()
export class TwelveDataDiagnosticsService {
  constructor(private readonly config: ConfigService) {}

  async inspect(input: unknown): Promise<TwelveDataDiagnosticResult> {
    const request = parseTwelveDataDiagnosticRequest(input);
    const apiKey = (this.config.get<string>('TWELVE_DATA_API_KEY') ?? '').trim();
    if (apiKey.length < 8) throw new Error('TWELVE_DATA_API_KEY_MISSING');
    const result =
      request.transport === 'WEBSOCKET'
        ? await this.inspectWebSocket(request, apiKey)
        : await this.inspectRest(request, apiKey);
    if (JSON.stringify(result).includes(apiKey)) throw new Error('TWELVE_DATA_SECRET_LEAK');
    return result;
  }

  private async inspectRest(
    request: TwelveDataDiagnosticRequest,
    apiKey: string,
  ): Promise<TwelveDataDiagnosticResult> {
    const endpoint = request.endpoint ?? '/quote';
    const params = buildTwelveDataDiagnosticParams({ ...request, endpoint });
    const url = new URL(
      endpoint,
      this.config.get<string>('TWELVE_DATA_REST_URL') ?? 'https://api.twelvedata.com',
    );
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    const started = performance.now();
    const response = await fetch(url, {
      headers: { accept: 'application/json', authorization: `apikey ${apiKey}` },
      signal: AbortSignal.timeout(
        Number(this.config.get<string>('TWELVE_DATA_REQUEST_TIMEOUT_MS') ?? '5000'),
      ),
    });
    const text = await readBoundedBody(response, 256 * 1024);
    return {
      provider: 'TwelveData',
      transport: 'REST',
      endpoint,
      request: params,
      durationMs: elapsed(started),
      httpStatus: response.status,
      credits: {
        used: boundedCredit(response.headers.get('api-credits-used')),
        left: boundedCredit(response.headers.get('api-credits-left')),
      },
      body: parseJsonOrText(text),
    };
  }

  private inspectWebSocket(
    request: TwelveDataDiagnosticRequest,
    apiKey: string,
  ): Promise<TwelveDataDiagnosticResult> {
    if (!request.symbol) throw new Error('TWELVE_DATA_DIAGNOSTIC_SYMBOL_REQUIRED');
    const symbol = request.exchange ? `${request.symbol}:${request.exchange}` : request.symbol;
    const endpoint = '/v1/quotes/price';
    const wsUrl = new URL(
      this.config.get<string>('TWELVE_DATA_WS_URL') ?? 'wss://ws.twelvedata.com/v1/quotes/price',
    );
    wsUrl.searchParams.set('apikey', apiKey);
    const started = performance.now();
    return new Promise((resolve, reject) => {
      const events: unknown[] = [];
      const socket = new WebSocket(wsUrl, { maxPayload: 64 * 1024, handshakeTimeout: 10_000 });
      let settled = false;
      let acknowledged = false;
      const finish = (timedOut = false): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        socket.close();
        resolve({
          provider: 'TwelveData',
          transport: 'WEBSOCKET',
          endpoint,
          request: { symbol },
          durationMs: elapsed(started),
          events,
          ...(timedOut ? { timedOut: true } : {}),
        });
      };
      const timeout = setTimeout(() => finish(true), 15_000);
      timeout.unref();
      socket.once('open', () => {
        socket.send(JSON.stringify({ action: 'subscribe', params: { symbols: symbol } }));
      });
      socket.on('message', (raw) => {
        const text = webSocketMessageText(raw);
        const event = parseJsonOrText(text);
        events.push(event);
        if (!isRecord(event)) return;
        if (event['event'] === 'subscribe-status') {
          acknowledged = event['status'] === 'ok';
          if (!acknowledged) finish();
        } else if (acknowledged && event['event'] === 'price') finish();
      });
      socket.once('error', () => {
        if (settled) return;
        clearTimeout(timeout);
        settled = true;
        reject(new Error('TWELVE_DATA_WS_CONNECT_FAILED'));
      });
      socket.once('close', () => {
        if (!settled) finish();
      });
    });
  }
}

export function parseTwelveDataDiagnosticRequest(input: unknown): TwelveDataDiagnosticRequest {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) throw new Error('TWELVE_DATA_DIAGNOSTIC_REQUEST_INVALID');
  if (parsed.data.transport === 'REST') {
    const endpoint = parsed.data.endpoint ?? '/quote';
    if (requiresSymbol.has(endpoint) && !parsed.data.symbol)
      throw new Error('TWELVE_DATA_DIAGNOSTIC_SYMBOL_REQUIRED');
    if (endpoint === '/time_series' && !parsed.data.interval)
      throw new Error('TWELVE_DATA_DIAGNOSTIC_INTERVAL_REQUIRED');
  } else if (!parsed.data.symbol) throw new Error('TWELVE_DATA_DIAGNOSTIC_SYMBOL_REQUIRED');
  return parsed.data;
}

export function buildTwelveDataDiagnosticParams(
  request: TwelveDataDiagnosticRequest & Readonly<{ endpoint: (typeof restEndpoints)[number] }>,
): Readonly<Record<string, string | number>> {
  const params: Record<string, string | number> = { format: 'JSON' };
  if (request.symbol) params['symbol'] = request.symbol;
  if (request.exchange && supportsExchange.has(request.endpoint))
    params['exchange'] = request.exchange;
  if (request.interval && request.endpoint === '/time_series')
    params['interval'] = request.interval;
  if (request.outputsize && supportsOutputsize.has(request.endpoint))
    params['outputsize'] = request.outputsize;
  if (request.page && supportsPage.has(request.endpoint)) params['page'] = request.page;
  return params;
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes)
    throw new Error('TWELVE_DATA_DIAGNOSTIC_RESPONSE_TOO_LARGE');
  const value: unknown = await response.arrayBuffer();
  if (!(value instanceof ArrayBuffer)) throw new Error('TWELVE_DATA_DIAGNOSTIC_BODY_INVALID');
  if (value.byteLength > maxBytes) throw new Error('TWELVE_DATA_DIAGNOSTIC_RESPONSE_TOO_LARGE');
  return new TextDecoder().decode(value);
}

function webSocketMessageText(raw: WebSocket.RawData): string {
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  return Buffer.concat(raw).toString('utf8');
}

function parseJsonOrText(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function boundedCredit(value: string | null): string | null {
  return value !== null && /^\d{1,12}$/u.test(value) ? value : null;
}

function elapsed(started: number): number {
  return Math.round((performance.now() - started) * 100) / 100;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
