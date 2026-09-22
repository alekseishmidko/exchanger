import { io, Socket } from 'socket.io-client';
import { ApiKeyRegistry } from '../../src/modules/gateway';
import { MarketDataHub } from '../../src/modules/market-data/domain/market-data';

/** Минимальный envelope shape, проверяемый WebSocket integration-тестом. */
export type TestEnvelope = Readonly<{
  messageVersion: string;
  correlationId: string;
  emittedAt: string;
  sequence: number;
  data: unknown;
}>;

/** Типы server events тестового Socket.IO client. */
interface ServerEvents {
  [event: string]: (payload: TestEnvelope) => void;
}

/** Типы client commands; runtime payload всё равно проверяет Zod на сервере. */
interface ClientEvents {
  [event: string]: (payload: unknown) => void;
}

/** Socket.IO client с versioned envelope server events. */
export type MarketDataClient = Socket<ServerEvents, ClientEvents>;

/** Stable principals для public/private WebSocket isolation сценариев. */
export function marketDataApiKeyRegistry(): ApiKeyRegistry {
  return new ApiKeyRegistry([
    { keyId: 'user-1-key', role: 'trader', userId: 'user-1' },
    { keyId: 'user-2-key', role: 'trader', userId: 'user-2' },
  ]);
}

/** Создаёт client с отключённым polling и автоматическим reconnect. */
export function marketDataClient(endpoint: string, apiKey?: string): MarketDataClient {
  return io(endpoint, {
    autoConnect: false,
    transports: ['websocket'],
    reconnection: false,
    ...(apiKey ? { auth: { apiKey } } : {}),
  });
}

/** Ожидает одно server event и завершает тест по timeout вместо зависания. */
export function nextEnvelope(
  socket: MarketDataClient,
  event: 'market.data' | 'market.ack' | 'market.error' | 'heartbeat.ack',
): Promise<TestEnvelope> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), 2000);
    socket.once(event, (payload) => {
      clearTimeout(timeout);
      resolve(payload);
    });
  });
}

/** Дожидается реального namespace connection либо отдаёт connect_error. */
export function waitForConnection(socket: MarketDataClient): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('WebSocket connection timeout')), 2000);
    socket.once('connect', () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.once('connect_error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    socket.connect();
  });
}

/** Публикует стандартный стакан BTC-USD перед каждым WebSocket сценарием. */
export function publishDefaultBookSnapshot(hub: MarketDataHub): void {
  hub.publishSnapshot({
    channel: 'book',
    instrumentId: 'BTC-USD',
    sequence: 1,
    bids: [{ price: '60000', quantity: '1' }],
    asks: [{ price: '60000.5', quantity: '2' }],
  });
}

/** Payload публичной подписки на стакан BTC-USD. */
export function publicBookSubscription(requestId = 'public-book-1') {
  return {
    requestId,
    channel: 'book',
    instrumentId: 'BTC-USD',
  } as const;
}

/** Payload private user stream подписки. */
export function privateUserSubscription(requestId: string, userId: string) {
  return {
    requestId,
    channel: 'user',
    userId,
  } as const;
}

/** Payload heartbeat команды для проверки лёгкого protocol path. */
export function heartbeatPayload(requestId = 'heartbeat-1') {
  return {
    requestId,
    sentAt: '2026-09-09T00:00:00.000Z',
  } as const;
}
