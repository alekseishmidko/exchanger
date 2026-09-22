import { HttpException } from '@nestjs/common';
import { WebSocketErrorDto } from '../dto/market-data.dto';

/** Безопасное описание protocol error без исходного exception и stack trace. */
export type MarketDataProtocolError = Readonly<
  WebSocketErrorDto & {
    /** `true`, если клиент может повторить команду после исправления состояния. */
    recoverable: boolean;
  }
>;

/**
 * Единая policy преобразования ошибок WebSocket market-data boundary.
 *
 * Gateway не должен сериализовать произвольный `Error`, Nest exception response
 * или stack trace напрямую в Socket.IO. Этот класс оставляет только
 * allow-listed публичный контракт: `code`, `message`, `recoverable`.
 *
 * @example
 * ```ts
 * const error = policy.fromUnknown(new HttpException({ code: 'AUTH_REQUIRED' }, 401));
 * // => { code: 'AUTH_REQUIRED', message: 'Request was rejected', recoverable: true }
 * ```
 */
export class MarketDataErrorPolicy {
  /** Возвращает ошибку malformed request с фиксированным текстом. */
  malformed(message: string): MarketDataProtocolError {
    return { code: 'REQUEST_MALFORMED', message, recoverable: true };
  }

  /** Возвращает ошибку нарушения server-side market-data contract. */
  contractViolation(): MarketDataProtocolError {
    return {
      code: 'MARKET_DATA_CONTRACT_VIOLATION',
      message: 'Market data message is invalid',
      recoverable: false,
    };
  }

  /** Возвращает ошибку backpressure для slow consumer. */
  backpressure(): MarketDataProtocolError {
    return {
      code: 'MARKET_DATA_BACKPRESSURE',
      message: 'Consumer is too slow',
      recoverable: false,
    };
  }

  /** Возвращает безопасную ошибку handshake без раскрытия деталей registry. */
  handshake(code: string, message: string): MarketDataProtocolError {
    return { code, message, recoverable: false };
  }

  /** Преобразует неизвестное исключение в стабильный protocol error. */
  fromUnknown(error: unknown): MarketDataProtocolError {
    if (error instanceof HttpException) {
      const response = error.getResponse();
      const fields = typeof response === 'object' ? (response as Record<string, unknown>) : {};
      return {
        code: typeof fields['code'] === 'string' ? fields['code'] : 'REQUEST_REJECTED',
        message: typeof fields['message'] === 'string' ? fields['message'] : 'Request was rejected',
        recoverable: error.getStatus() < 500,
      };
    }
    return {
      code: 'MARKET_DATA_UNAVAILABLE',
      message: 'Market data is unavailable',
      recoverable: true,
    };
  }

  /**
   * Извлекает безопасный correlation fallback из malformed payload.
   *
   * Значение ограничено длиной и строковым типом, чтобы неожиданный JSON не
   * попал в логи или envelope metadata как объект/массив.
   */
  requestId(raw: unknown): string {
    if (typeof raw === 'object' && raw && 'requestId' in raw) {
      const value = (raw as { requestId?: unknown }).requestId;
      if (typeof value === 'string' && value.length <= 128) return value;
    }
    return 'unknown';
  }
}
