import { ConfigService } from '@nestjs/config';
import type { ApiKeyRegistry } from '../../gateway/auth/gateway.auth';
import type { AuthenticatedSocket } from '../transport/market-data.gateway.types';

/** Результат handshake проверки без сериализации exception наружу. */
export type MarketDataConnectionDecision =
  | Readonly<{ ok: true }>
  | Readonly<{
      ok: false;
      code: 'WEBSOCKET_ORIGIN_FORBIDDEN' | 'AUTH_INVALID_API_KEY';
      message: string;
    }>;

/**
 * Политика handshake для WebSocket namespace.
 *
 * Проверяет browser Origin и optional API key. Public clients могут подключаться
 * без ключа, private доступ появляется только если ключ успешно аутентифицирован
 * и principal сохранён в `socket.data`.
 */
export class MarketDataConnectionPolicy {
  private readonly allowedOrigins: ReadonlySet<string>;

  /** Создаёт policy из валидированной NestJS configuration. */
  constructor(config: ConfigService) {
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
  }

  /** Проверяет origin/API key и заполняет principal при успешной auth. */
  async authenticate(
    client: AuthenticatedSocket,
    apiKeys: ApiKeyRegistry,
  ): Promise<MarketDataConnectionDecision> {
    const origin = client.handshake.headers.origin;
    if (origin && !this.allowedOrigins.has('*') && !this.allowedOrigins.has(origin)) {
      return {
        ok: false,
        code: 'WEBSOCKET_ORIGIN_FORBIDDEN',
        message: 'Origin is forbidden',
      };
    }
    const headerKey = client.handshake.headers['x-api-key'];
    const auth = client.handshake.auth as Record<string, unknown>;
    const authKey = auth['apiKey'];
    const apiKey =
      typeof authKey === 'string' ? authKey : typeof headerKey === 'string' ? headerKey : undefined;
    if (!apiKey) return { ok: true };
    try {
      client.data.principal = await apiKeys.authenticate(apiKey);
      return { ok: true };
    } catch {
      return { ok: false, code: 'AUTH_INVALID_API_KEY', message: 'Authentication failed' };
    }
  }
}
