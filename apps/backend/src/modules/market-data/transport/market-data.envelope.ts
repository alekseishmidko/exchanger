import type { WebSocketEnvelope } from '../dto/market-data.dto';

/**
 * Factory единого versioned WebSocket envelope.
 *
 * Data messages получают sequence из payload, а control messages используют
 * sequence `0`, чтобы клиент не смешивал ack/error/heartbeat с order-book
 * ordering.
 */
export class MarketDataEnvelopeFactory {
  /** Создаёт envelope protocol version 1.0. */
  create<T>(correlationId: string, data: T): WebSocketEnvelope<T> {
    return {
      messageVersion: '1.0',
      correlationId,
      emittedAt: new Date().toISOString(),
      sequence: this.sequenceOf(data),
      data,
    };
  }

  /** Извлекает market sequence только из валидного payload. */
  private sequenceOf(data: unknown): number {
    if (typeof data === 'object' && data && 'sequence' in data) {
      const sequence = (data as { sequence?: unknown }).sequence;
      if (typeof sequence === 'number' && Number.isInteger(sequence) && sequence >= 0) {
        return sequence;
      }
    }
    return 0;
  }
}
