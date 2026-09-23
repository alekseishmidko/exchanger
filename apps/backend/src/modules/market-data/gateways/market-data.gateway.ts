import { HttpException, Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import { ApiKeyRegistry } from '../../gateway/auth/gateway.auth';
import { BackpressureError, MarketDataHub, MarketDataMessage } from '../domain/market-data';
import { MarketDataConnectionPolicy } from '../policies/market-data.connection-policy';
import {
  MarketDataErrorPolicy,
  MarketDataProtocolError,
} from '../policies/market-data-error.policy';
import {
  HeartbeatRequestDto,
  HeartbeatResponseDto,
  ResyncRequestDto,
  SubscribeRequestDto,
  SubscriptionAckDto,
  UnsubscribeRequestDto,
  WebSocketErrorDto,
} from '../dto/market-data.dto';
import { MarketDataEnvelopeFactory } from '../transport/market-data.envelope';
import type { AuthenticatedSocket } from '../transport/market-data.gateway.types';
import { MarketDataSubscriptionRegistry } from '../registries/market-data.subscription-registry';
import { MarketDataTelemetryObserver } from '../transport/market-data-telemetry.observer';
import {
  heartbeatSchema,
  marketDataMessageSchema,
  resyncSchema,
  subscriptionSchema,
} from '../validation/market-data.validation';
import {
  LOG_EVENTS,
  NOOP_OPERATIONAL_LOGGER,
  OperationalLogger,
  StructuredLogger,
  MetricsService,
  TelemetryService,
  TraceCarrier,
} from '../../observability';

/**
 * Настоящий NestJS Socket.IO adapter над transport-independent `MarketDataHub`.
 *
 * Namespace `/market-data` принимает четыре client events:
 * `market.subscribe`, `market.unsubscribe`, `market.resync`, `heartbeat`.
 * Сервер отправляет `market.data`, `market.ack`, `market.error` и
 * `heartbeat.ack`. Public subscriptions не требуют ключа; private subscription
 * использует только principal из handshake `auth.apiKey` или `x-api-key` header.
 *
 * @example
 * ```ts
 * const socket = io('ws://localhost:5001/market-data', {
 *   transports: ['websocket'],
 *   auth: { apiKey: 'client-key' },
 * });
 * socket.emit('market.subscribe', {
 *   requestId: 'req-1', channel: 'book', instrumentId: 'BTC-USD'
 * });
 * ```
 */
@Injectable()
@WebSocketGateway({
  namespace: '/market-data',
  transports: ['websocket'],
  maxHttpBufferSize: 16 * 1024,
  serveClient: false,
})
export class MarketDataGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly subscriptions = new MarketDataSubscriptionRegistry();
  private readonly connectionPolicy: MarketDataConnectionPolicy;
  private readonly errorPolicy = new MarketDataErrorPolicy();
  private readonly envelopes = new MarketDataEnvelopeFactory();
  private readonly observer: MarketDataTelemetryObserver;
  private readonly maxPendingMessages: number;
  private readonly logger: OperationalLogger;

  /**
   * Собирает WebSocket transport boundary и его эксплуатационные ограничения.
   *
   * Hub остаётся transport-independent, registry выполняет handshake auth,
   * metrics записывает только bounded operation/channel/outcome, а telemetry
   * продолжает переданный клиентом W3C context. Logger optional для изолированных
   * unit-тестов, но в NestJS composition root заменяется production adapter-ом.
   *
   * @param hub Источник snapshot, replay и fan-out подписок.
   * @param apiKeys Registry для проверки ключа только на private boundary.
   * @param config Валидированные origin и backpressure limits.
   * @param metrics RED-метрики сообщений WebSocket.
   * @param telemetry OpenTelemetry adapter для message spans.
   * @param logger Необязательный operational logger с no-op fallback.
   */
  constructor(
    private readonly hub: MarketDataHub,
    private readonly apiKeys: ApiKeyRegistry,
    config: ConfigService,
    metrics: MetricsService,
    telemetry: TelemetryService,
    @Optional() @Inject(StructuredLogger) logger?: StructuredLogger,
  ) {
    this.logger = logger ?? NOOP_OPERATIONAL_LOGGER;
    this.connectionPolicy = new MarketDataConnectionPolicy(config);
    this.observer = new MarketDataTelemetryObserver(metrics, telemetry);
    this.maxPendingMessages = Number(config.get<string | number>('WEBSOCKET_MAX_PENDING', 100));
  }

  /**
   * Проверяет browser origin и optional API key до приёма subscription-команд.
   * Invalid key приводит к protocol error и немедленному disconnect; public
   * клиент должен вообще не передавать ключ, а не отправлять фиктивное значение.
   * Успешный principal хранится только в `socket.data` и не возвращается клиенту.
   *
   * @example Browser с `Origin: https://exchange.example.com` допускается только
   * если этот origin перечислен в `WEBSOCKET_ALLOWED_ORIGINS`.
   */
  handleConnection(client: AuthenticatedSocket): void {
    const decision = this.connectionPolicy.authenticate(client, this.apiKeys);
    if (!decision.ok) {
      this.emitError(
        client,
        'handshake',
        this.errorPolicy.handshake(decision.code, decision.message),
      );
      client.disconnect(true);
      return;
    }
    this.subscriptions.open(client.id);
    this.logger.info('market-data', LOG_EVENTS.WEBSOCKET_CONNECTED, {
      metadata: { authenticated: Boolean(client.data.principal) },
    });
  }

  /**
   * Снимает все hub callbacks независимо от причины transport disconnect.
   * Например, если один socket слушал `book:BTC-USD` и `ticker:BTC-USD`, обе
   * unsubscribe-функции вызываются до удаления socket registry.
   */
  handleDisconnect(client: AuthenticatedSocket): void {
    this.subscriptions.close(client.id);
  }

  /**
   * Валидирует и регистрирует public/private subscription.
   * Для public channel callback создаётся по instrument, для private — только
   * после exact-match `request.userId === principal.userId`. Сообщения producer,
   * пришедшие синхронно во время регистрации, буферизуются до отправки ack.
   *
   * @example `market.subscribe` с `{ requestId: 'r1', channel: 'book',
   * instrumentId: 'BTC-USD' }` даёт ack, затем initial snapshot.
   */
  @SubscribeMessage('market.subscribe')
  subscribe(@ConnectedSocket() client: AuthenticatedSocket, @MessageBody() raw: unknown): void {
    const result = subscriptionSchema.safeParse(raw);
    if (!result.success) {
      this.emitError(
        client,
        this.requestId(raw),
        this.errorPolicy.malformed('Subscription is invalid'),
      );
      return;
    }
    const request: SubscribeRequestDto = result.data;
    this.observeMessage('subscribe', request.channel, request.trace ?? {}, () =>
      this.subscribeValidated(client, request),
    );
  }

  /** Регистрирует уже валидированную подписку внутри WebSocket tracing context. */
  private subscribeValidated(client: AuthenticatedSocket, request: SubscribeRequestDto): void {
    try {
      const key = this.subscriptionKey(request);
      const current = this.subscriptions.current(client.id);
      if (!current) return;
      const pendingMessages: MarketDataMessage[] = [];
      let acknowledged = false;
      const deliver = (message: MarketDataMessage): void => {
        if (acknowledged) this.emitMarketData(client, request.requestId, message);
        else pendingMessages.push(message);
      };
      const unsubscribe =
        request.channel === 'user'
          ? this.subscribePrivate(client, request)
          : this.hub.subscribePublic(
              client.id,
              request.instrumentId ?? '',
              request.channel,
              deliver,
            );
      this.subscriptions.replace(client.id, { key, unsubscribe });
      this.emitEnvelope<SubscriptionAckDto>(client, 'market.ack', request.requestId, {
        action: 'subscribed',
        subscription: key,
      });
      acknowledged = true;
      this.logger.info('market-data', LOG_EVENTS.WEBSOCKET_SUBSCRIBED, {
        correlationId: request.requestId,
        metadata: { channel: request.channel, instrumentId: request.instrumentId ?? null },
      });
      for (const message of pendingMessages)
        this.emitMarketData(client, request.requestId, message);
    } catch (error) {
      this.emitKnownError(client, request.requestId, error);
    }
  }

  /**
   * Снимает ровно одну подписку и оставляет остальные каналы активными.
   * Повторная команда для отсутствующего ключа также получает ack, то есть client
   * retry не превращается в protocol error.
   *
   * @example Отписка `book:BTC-USD` не затрагивает `ticker:BTC-USD`.
   */
  @SubscribeMessage('market.unsubscribe')
  unsubscribe(@ConnectedSocket() client: AuthenticatedSocket, @MessageBody() raw: unknown): void {
    const result = subscriptionSchema.safeParse(raw);
    if (!result.success) {
      this.emitError(
        client,
        this.requestId(raw),
        this.errorPolicy.malformed('Unsubscribe is invalid'),
      );
      return;
    }
    const request: UnsubscribeRequestDto = result.data;
    this.observeMessage('unsubscribe', request.channel, request.trace ?? {}, () => {
      const key = this.subscriptionKey(request);
      this.subscriptions.remove(client.id, key);
      this.emitEnvelope<SubscriptionAckDto>(client, 'market.ack', request.requestId, {
        action: 'unsubscribed',
        subscription: key,
      });
    });
  }

  /**
   * Возвращает ordered replay либо новый snapshot после gap/reconnect.
   * `lastSequence` передаётся transport-independent hub: при доступном диапазоне
   * клиент получает N+1...current, иначе snapshot на current sequence.
   *
   * @example При `lastSequence=41` и сохранённых 42,43 отправляются два increment.
   */
  @SubscribeMessage('market.resync')
  resync(@ConnectedSocket() client: AuthenticatedSocket, @MessageBody() raw: unknown): void {
    const result = resyncSchema.safeParse(raw);
    if (!result.success) {
      this.emitError(client, this.requestId(raw), this.errorPolicy.malformed('Resync is invalid'));
      return;
    }
    const request: ResyncRequestDto = result.data;
    this.observeMessage('resync', 'book', request.trace ?? {}, () => {
      try {
        for (const message of this.hub.resync(request.instrumentId, request.lastSequence)) {
          this.emitMarketData(client, request.requestId, message);
        }
      } catch (error) {
        this.emitKnownError(client, request.requestId, error);
      }
    });
  }

  /**
   * Отвечает без обращения к hub, БД или event log.
   * Это transport heartbeat, а не readiness probe: он доказывает только живость
   * Socket.IO connection и event loop.
   *
   * @example `heartbeat({requestId:'ping-1'})` создаёт `heartbeat.ack` sequence 0.
   */
  @SubscribeMessage('heartbeat')
  heartbeat(@ConnectedSocket() client: AuthenticatedSocket, @MessageBody() raw: unknown): void {
    const result = heartbeatSchema.safeParse(raw);
    if (!result.success) {
      this.emitError(
        client,
        this.requestId(raw),
        this.errorPolicy.malformed('Heartbeat is invalid'),
      );
      return;
    }
    const request: HeartbeatRequestDto = result.data;
    this.observeMessage('heartbeat', 'control', request.trace ?? {}, () => {
      this.emitEnvelope<HeartbeatResponseDto>(client, 'heartbeat.ack', request.requestId, {
        receivedAt: new Date().toISOString(),
        ...(request.sentAt ? { sentAt: request.sentAt } : {}),
      });
    });
  }

  /** Создаёт private callback только после наличия и object authorization principal. */
  private subscribePrivate(client: AuthenticatedSocket, request: SubscribeRequestDto): () => void {
    const principal = client.data.principal;
    if (!principal) {
      throw new HttpException(
        { code: 'AUTH_REQUIRED', message: 'Private subscription requires authentication' },
        401,
      );
    }
    return this.hub.subscribePrivate(client.id, principal.userId, request.userId ?? '', (message) =>
      this.emitMarketData(client, request.requestId, message),
    );
  }

  /** Проверяет реальный Socket.IO write buffer перед добавлением сообщения. */
  private emitMarketData(
    client: AuthenticatedSocket,
    correlationId: string,
    message: MarketDataMessage,
  ): void {
    const validated = marketDataMessageSchema.safeParse(message);
    if (!validated.success) {
      this.emitError(client, correlationId, this.errorPolicy.contractViolation());
      client.disconnect(true);
      return;
    }
    const connection = client.conn as unknown as { writeBuffer?: readonly unknown[] };
    if ((connection.writeBuffer?.length ?? 0) >= this.maxPendingMessages) {
      this.emitError(client, correlationId, this.errorPolicy.backpressure());
      client.disconnect(true);
      throw new BackpressureError();
    }
    this.emitEnvelope(client, 'market.data', correlationId, validated.data);
  }

  /** Формирует единый versioned envelope для всех server events. */
  private emitEnvelope<T>(
    client: AuthenticatedSocket,
    event: 'market.data' | 'market.ack' | 'market.error' | 'heartbeat.ack',
    correlationId: string,
    data: T,
  ): void {
    client.emit(event, this.envelopes.create(correlationId, data));
  }

  /** Преобразует domain/HTTP exception в allow-listed protocol error. */
  private emitKnownError(client: AuthenticatedSocket, correlationId: string, error: unknown): void {
    this.emitError(client, correlationId, this.errorPolicy.fromUnknown(error));
  }

  /** Отправляет безопасную ошибку, не сериализуя исходный exception. */
  private emitError(
    client: AuthenticatedSocket,
    correlationId: string,
    error: MarketDataProtocolError,
  ): void {
    this.logger.warn('market-data', LOG_EVENTS.WEBSOCKET_REJECTED, {
      correlationId,
      metadata: { code: error.code, recoverable: error.recoverable },
    });
    this.emitEnvelope<WebSocketErrorDto>(client, 'market.error', correlationId, {
      code: error.code,
      message: error.message,
      recoverable: error.recoverable,
    });
  }

  /** Строит стабильный ключ подписки для replace/unsubscribe semantics. */
  private subscriptionKey(request: SubscribeRequestDto): string {
    return request.channel === 'user'
      ? `user:${request.userId ?? ''}`
      : `${request.channel}:${request.instrumentId ?? ''}`;
  }

  /** Извлекает безопасный correlation fallback из malformed payload. */
  private requestId(raw: unknown): string {
    return this.errorPolicy.requestId(raw);
  }

  /**
   * Продолжает W3C trace WebSocket-команды и записывает RED metric.
   * Operation/channel проходят bounded allow-list в MetricsService, поэтому
   * requestId и socketId не создают отдельные time series.
   */
  private observeMessage(
    operation: string,
    channel: string,
    carrier: TraceCarrier,
    handler: () => void,
  ): void {
    this.observer.observe(operation, channel, carrier, handler);
  }
}
