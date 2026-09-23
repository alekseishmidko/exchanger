import type { Socket } from 'socket.io';
import type { ApiKeyPrincipal } from '../../gateway/auth/gateway.auth';
import type { WebSocketEnvelope } from '../dto/market-data.dto';

/** Client events принимают unknown payload и валидируют его до использования. */
export interface ClientToServerEvents {
  'market.subscribe': (payload: unknown) => void;
  'market.unsubscribe': (payload: unknown) => void;
  'market.resync': (payload: unknown) => void;
  heartbeat: (payload: unknown) => void;
}

/** Server events всегда передают единый versioned envelope. */
export interface ServerToClientEvents {
  'market.data': (payload: WebSocketEnvelope<unknown>) => void;
  'market.ack': (payload: WebSocketEnvelope<unknown>) => void;
  'market.error': (payload: WebSocketEnvelope<unknown>) => void;
  'heartbeat.ack': (payload: WebSocketEnvelope<unknown>) => void;
}

/** Socket data содержит только principal, полученный из handshake API key. */
export type SocketData = { principal?: ApiKeyPrincipal };

/** Типизированный Socket.IO transport клиента market-data namespace. */
export type AuthenticatedSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  never,
  SocketData
>;

/** Хранимая unsubscribe-функция для очистки hub registry при disconnect. */
export type ActiveSubscription = Readonly<{ key: string; unsubscribe: () => void }>;
