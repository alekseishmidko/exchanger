import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import { realtimeSubscriptionSchema, type ReferenceQuote } from '@exchange/contracts';
import type { Socket } from 'socket.io';
import { z } from 'zod';
import { ApiKeyRegistry, assertAuthorizedAction, type ApiKeyPrincipal } from '../../auth';
import { MarketDataAbuseControl } from '../../market-data/policies/market-data-abuse-control';
import { MarketDataConnectionPolicy } from '../../market-data/policies/market-data.connection-policy';
import type { AuthenticatedSocket } from '../../market-data/transport/market-data.gateway.types';
import { RealtimeMarketHub } from '../application/realtime-market-hub';
import { RealtimeMarketStatusService } from '../application/realtime-market-status.service';
import { QUOTE_STORE_PORT, type QuoteStorePort } from '../ports/quote-store.port';
import { REALTIME_CATALOG_PORT, type RealtimeCatalogPort } from '../ports/realtime-catalog.port';
import { Inject } from '@nestjs/common';

type RealtimeSocket = Socket<
  Record<string, (payload: unknown) => void>,
  Record<string, (payload: unknown) => void>,
  never,
  { principal?: ApiKeyPrincipal }
>;
const heartbeatSchema = z.object({ requestId: z.string().min(1).max(128) }).strict();

@Injectable()
@WebSocketGateway({
  namespace: '/realtime-market-data',
  transports: ['websocket'],
  maxHttpBufferSize: 16 * 1024,
  serveClient: false,
})
export class RealtimeMarketGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly connectionPolicy: MarketDataConnectionPolicy;
  private readonly subscriptions = new Map<string, Map<string, () => void>>();
  private readonly connectionCleanup = new Map<string, readonly (() => void)[]>();
  private readonly pending = new Map<string, number>();
  private readonly maxSubscriptions: number;
  private readonly maxPending: number;

  constructor(
    private readonly apiKeys: ApiKeyRegistry,
    private readonly abuse: MarketDataAbuseControl,
    private readonly hub: RealtimeMarketHub,
    private readonly status: RealtimeMarketStatusService,
    @Inject(QUOTE_STORE_PORT) private readonly quotes: QuoteStorePort,
    @Inject(REALTIME_CATALOG_PORT) private readonly catalog: RealtimeCatalogPort,
    config: ConfigService,
  ) {
    this.connectionPolicy = new MarketDataConnectionPolicy(config);
    this.maxSubscriptions = Number(config.get('REALTIME_MAX_SUBSCRIPTIONS_PER_SOCKET', '20'));
    this.maxPending = Number(config.get('REALTIME_MAX_PENDING_MESSAGES', '100'));
  }

  async handleConnection(client: RealtimeSocket): Promise<void> {
    const compatible = client as AuthenticatedSocket;
    if (!(await this.abuse.admitIp(compatible))) {
      client.disconnect(true);
      return;
    }
    const decision = await this.connectionPolicy.authenticate(compatible, this.apiKeys);
    if (!decision.ok || !client.data.principal) {
      this.emit(client, 'realtime.error', 'handshake', {
        code: decision.ok ? 'AUTH_REQUIRED' : decision.code,
        message: decision.ok ? 'Authentication is required' : decision.message,
      });
      this.abuse.release(compatible);
      client.disconnect(true);
      return;
    }
    try {
      assertAuthorizedAction(client.data.principal, 'trading.read');
    } catch {
      this.abuse.release(compatible);
      client.disconnect(true);
      return;
    }
    if (!(await this.abuse.admitPrincipal(compatible, client.data.principal.userId))) {
      this.abuse.release(compatible);
      client.disconnect(true);
      return;
    }
    this.subscriptions.set(client.id, new Map());
    const cleanup = [
      this.hub.subscribeStatus((value) => this.emit(client, 'realtime.status', 'status', value)),
      this.hub.subscribeExecution(client.data.principal.userId, (value) =>
        this.emit(client, 'realtime.execution', value.commandId, value),
      ),
    ];
    this.connectionCleanup.set(client.id, cleanup);
    this.emit(client, 'realtime.status', 'status', this.status.snapshot());
  }

  handleDisconnect(client: RealtimeSocket): void {
    for (const unsubscribe of this.subscriptions.get(client.id)?.values() ?? []) unsubscribe();
    for (const unsubscribe of this.connectionCleanup.get(client.id) ?? []) unsubscribe();
    this.subscriptions.delete(client.id);
    this.connectionCleanup.delete(client.id);
    this.pending.delete(client.id);
    this.abuse.release(client);
  }

  @SubscribeMessage('realtime.subscribe')
  async subscribe(
    @ConnectedSocket() client: RealtimeSocket,
    @MessageBody() raw: unknown,
  ): Promise<void> {
    if (!(await this.abuse.admitMessage(client))) return;
    const parsed = realtimeSubscriptionSchema.safeParse(raw);
    if (!parsed.success) return this.protocolError(client, raw, 'REALTIME_SUBSCRIPTION_INVALID');
    const current = this.subscriptions.get(client.id);
    if (!current) return;
    const requested = new Set(parsed.data.instrumentIds);
    if (new Set([...current.keys(), ...requested]).size > this.maxSubscriptions)
      return this.protocolError(client, raw, 'REALTIME_SUBSCRIPTION_LIMIT');
    const snapshots: ReferenceQuote[] = [];
    for (const instrumentId of requested) {
      const instrument = await this.catalog.get(instrumentId);
      if (!instrument || instrument.status !== 'ACTIVE' || !instrument.priceEnabled) {
        this.emit(client, 'realtime.status', parsed.data.requestId, {
          instrumentId,
          status: 'UNAVAILABLE',
        });
        continue;
      }
      if (!current.has(instrumentId))
        current.set(
          instrumentId,
          this.hub.subscribeQuote(instrumentId, (quote) =>
            this.emit(client, 'realtime.quote', parsed.data.requestId, quote),
          ),
        );
      const quote = await this.quotes.getLatest(instrumentId);
      if (quote) snapshots.push(quote);
      else
        this.emit(client, 'realtime.status', parsed.data.requestId, {
          instrumentId,
          status: 'UNAVAILABLE',
        });
    }
    this.emit(client, 'realtime.ack', parsed.data.requestId, {
      action: 'subscribed',
      instrumentIds: [...requested],
    });
    for (const quote of snapshots)
      this.emit(client, 'realtime.quote', parsed.data.requestId, quote);
  }

  @SubscribeMessage('realtime.unsubscribe')
  async unsubscribe(
    @ConnectedSocket() client: RealtimeSocket,
    @MessageBody() raw: unknown,
  ): Promise<void> {
    if (!(await this.abuse.admitMessage(client))) return;
    const parsed = realtimeSubscriptionSchema.safeParse(raw);
    if (!parsed.success) return this.protocolError(client, raw, 'REALTIME_SUBSCRIPTION_INVALID');
    const current = this.subscriptions.get(client.id);
    for (const instrumentId of parsed.data.instrumentIds) {
      current?.get(instrumentId)?.();
      current?.delete(instrumentId);
    }
    this.emit(client, 'realtime.ack', parsed.data.requestId, {
      action: 'unsubscribed',
      instrumentIds: parsed.data.instrumentIds,
    });
  }

  @SubscribeMessage('heartbeat')
  async heartbeat(
    @ConnectedSocket() client: RealtimeSocket,
    @MessageBody() raw: unknown,
  ): Promise<void> {
    if (!(await this.abuse.admitMessage(client))) return;
    const parsed = heartbeatSchema.safeParse(raw);
    if (!parsed.success) return this.protocolError(client, raw, 'REALTIME_HEARTBEAT_INVALID');
    this.emit(client, 'heartbeat.ack', parsed.data.requestId, {
      receivedAt: new Date().toISOString(),
    });
  }

  private protocolError(client: RealtimeSocket, raw: unknown, code: string): void {
    const requestId =
      typeof raw === 'object' &&
      raw !== null &&
      'requestId' in raw &&
      typeof raw.requestId === 'string'
        ? raw.requestId
        : 'unknown';
    this.emit(client, 'realtime.error', requestId, { code, message: 'Realtime command rejected' });
  }

  private emit(client: RealtimeSocket, event: string, requestId: string, data: unknown): void {
    const pending = (this.pending.get(client.id) ?? 0) + 1;
    if (pending > this.maxPending) {
      client.disconnect(true);
      return;
    }
    this.pending.set(client.id, pending);
    client.emit(event, { version: 1, requestId, emittedAt: new Date().toISOString(), data });
    queueMicrotask(() => this.pending.set(client.id, Math.max(0, pending - 1)));
  }
}
