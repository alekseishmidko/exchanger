import { HttpException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import { Socket } from 'socket.io';
import { ApiKeyPrincipal, ApiKeyRegistry } from '../gateway/gateway.auth';
import { BackpressureError, MarketDataHub, MarketDataMessage } from './market-data';
import {
  HeartbeatRequestDto,
  HeartbeatResponseDto,
  ResyncRequestDto,
  SubscribeRequestDto,
  SubscriptionAckDto,
  UnsubscribeRequestDto,
  WebSocketEnvelope,
  WebSocketErrorDto,
} from './market-data.dto';
import {
  heartbeatSchema,
  marketDataMessageSchema,
  resyncSchema,
  subscriptionSchema,
} from './market-data.validation';

/** Client events принимают unknown payload и валидируют его до использования. */
interface ClientToServerEvents {
  'market.subscribe': (payload: unknown) => void;
  'market.unsubscribe': (payload: unknown) => void;
  'market.resync': (payload: unknown) => void;
  heartbeat: (payload: unknown) => void;
}

/** Server events всегда передают единый versioned envelope. */
interface ServerToClientEvents {
  'market.data': (payload: WebSocketEnvelope<unknown>) => void;
  'market.ack': (payload: WebSocketEnvelope<unknown>) => void;
  'market.error': (payload: WebSocketEnvelope<unknown>) => void;
  'heartbeat.ack': (payload: WebSocketEnvelope<unknown>) => void;
}

/** Socket data содержит только principal, полученный из handshake API key. */
type SocketData = { principal?: ApiKeyPrincipal };

/** Типизированный Socket.IO transport клиента market-data namespace. */
type AuthenticatedSocket = Socket<ClientToServerEvents, ServerToClientEvents, never, SocketData>;

/** Хранимая unsubscribe-функция для очистки hub registry при disconnect. */
type ActiveSubscription = Readonly<{ key: string; unsubscribe: () => void }>;

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
  private readonly subscriptions = new Map<string, Map<string, ActiveSubscription>>();
  private readonly allowedOrigins: ReadonlySet<string>;
  private readonly maxPendingMessages: number;

  constructor(
    private readonly hub: MarketDataHub,
    private readonly apiKeys: ApiKeyRegistry,
    config: ConfigService,
  ) {
    const origins = config.get<string>(
      'WEBSOCKET_ALLOWED_ORIGINS',
      'http://localhost:3000,http://localhost:5001',
    );
    this.allowedOrigins = new Set(
      origins
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    );
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
    const origin = client.handshake.headers.origin;
    if (origin && !this.allowedOrigins.has('*') && !this.allowedOrigins.has(origin)) {
      this.emitError(
        client,
        'handshake',
        'WEBSOCKET_ORIGIN_FORBIDDEN',
        'Origin is forbidden',
        false,
      );
      client.disconnect(true);
      return;
    }
    const headerKey = client.handshake.headers['x-api-key'];
    const auth = client.handshake.auth as Record<string, unknown>;
    const authKey = auth['apiKey'];
    const apiKey =
      typeof authKey === 'string' ? authKey : typeof headerKey === 'string' ? headerKey : undefined;
    if (apiKey) {
      try {
        client.data.principal = this.apiKeys.authenticate(apiKey);
      } catch {
        this.emitError(client, 'handshake', 'AUTH_INVALID_API_KEY', 'Authentication failed', false);
        client.disconnect(true);
        return;
      }
    }
    this.subscriptions.set(client.id, new Map());
  }

  /**
   * Снимает все hub callbacks независимо от причины transport disconnect.
   * Например, если один socket слушал `book:BTC-USD` и `ticker:BTC-USD`, обе
   * unsubscribe-функции вызываются до удаления socket registry.
   */
  handleDisconnect(client: AuthenticatedSocket): void {
    for (const subscription of this.subscriptions.get(client.id)?.values() ?? []) {
      subscription.unsubscribe();
    }
    this.subscriptions.delete(client.id);
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
        'REQUEST_MALFORMED',
        'Subscription is invalid',
        true,
      );
      return;
    }
    const request: SubscribeRequestDto = result.data;
    try {
      const key = this.subscriptionKey(request);
      const current = this.subscriptions.get(client.id);
      if (!current) return;
      current.get(key)?.unsubscribe();
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
      current.set(key, { key, unsubscribe });
      this.emitEnvelope<SubscriptionAckDto>(client, 'market.ack', request.requestId, {
        action: 'subscribed',
        subscription: key,
      });
      acknowledged = true;
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
        'REQUEST_MALFORMED',
        'Unsubscribe is invalid',
        true,
      );
      return;
    }
    const request: UnsubscribeRequestDto = result.data;
    const key = this.subscriptionKey(request);
    this.subscriptions.get(client.id)?.get(key)?.unsubscribe();
    this.subscriptions.get(client.id)?.delete(key);
    this.emitEnvelope<SubscriptionAckDto>(client, 'market.ack', request.requestId, {
      action: 'unsubscribed',
      subscription: key,
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
      this.emitError(client, this.requestId(raw), 'REQUEST_MALFORMED', 'Resync is invalid', true);
      return;
    }
    const request: ResyncRequestDto = result.data;
    try {
      for (const message of this.hub.resync(request.instrumentId, request.lastSequence)) {
        this.emitMarketData(client, request.requestId, message);
      }
    } catch (error) {
      this.emitKnownError(client, request.requestId, error);
    }
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
        'REQUEST_MALFORMED',
        'Heartbeat is invalid',
        true,
      );
      return;
    }
    const request: HeartbeatRequestDto = result.data;
    this.emitEnvelope<HeartbeatResponseDto>(client, 'heartbeat.ack', request.requestId, {
      receivedAt: new Date().toISOString(),
      ...(request.sentAt ? { sentAt: request.sentAt } : {}),
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
      this.emitError(
        client,
        correlationId,
        'MARKET_DATA_CONTRACT_VIOLATION',
        'Market data message is invalid',
        false,
      );
      client.disconnect(true);
      return;
    }
    const connection = client.conn as unknown as { writeBuffer?: readonly unknown[] };
    if ((connection.writeBuffer?.length ?? 0) >= this.maxPendingMessages) {
      this.emitError(
        client,
        correlationId,
        'MARKET_DATA_BACKPRESSURE',
        'Consumer is too slow',
        false,
      );
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
    const envelope: WebSocketEnvelope<T> = {
      messageVersion: '1.0',
      correlationId,
      emittedAt: new Date().toISOString(),
      sequence: this.sequenceOf(data),
      data,
    };
    client.emit(event, envelope);
  }

  /**
   * Переносит market sequence в envelope; control messages используют ноль.
   * Ноль не участвует в order-book ordering и явно отделяет ack/error/heartbeat
   * от последовательности событий конкретного инструмента или пользователя.
   */
  private sequenceOf(data: unknown): number {
    if (typeof data === 'object' && data && 'sequence' in data) {
      const sequence = (data as { sequence?: unknown }).sequence;
      if (typeof sequence === 'number' && Number.isInteger(sequence) && sequence >= 0)
        return sequence;
    }
    return 0;
  }

  /** Преобразует domain/HTTP exception в allow-listed protocol error. */
  private emitKnownError(client: AuthenticatedSocket, correlationId: string, error: unknown): void {
    if (error instanceof HttpException) {
      const response = error.getResponse();
      const fields = typeof response === 'object' ? (response as Record<string, unknown>) : {};
      this.emitError(
        client,
        correlationId,
        typeof fields['code'] === 'string' ? fields['code'] : 'REQUEST_REJECTED',
        typeof fields['message'] === 'string' ? fields['message'] : 'Request was rejected',
        error.getStatus() < 500,
      );
      return;
    }
    this.emitError(
      client,
      correlationId,
      'MARKET_DATA_UNAVAILABLE',
      'Market data is unavailable',
      true,
    );
  }

  /** Отправляет безопасную ошибку, не сериализуя исходный exception. */
  private emitError(
    client: AuthenticatedSocket,
    correlationId: string,
    code: string,
    message: string,
    recoverable: boolean,
  ): void {
    this.emitEnvelope<WebSocketErrorDto>(client, 'market.error', correlationId, {
      code,
      message,
      recoverable,
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
    if (typeof raw === 'object' && raw && 'requestId' in raw) {
      const value = (raw as { requestId?: unknown }).requestId;
      if (typeof value === 'string' && value.length <= 128) return value;
    }
    return 'unknown';
  }
}
