import type { LogEvent } from './event-log';

/**
 * Стабильный DI-токен durable append/consume event boundary.
 *
 * Producer и consumers используют port, не импортируя PostgreSQL или broker
 * client. Это сохраняет domain tests детерминированными и заменяемыми.
 */
export const EVENT_LOG_PORT = Symbol('EVENT_LOG_PORT');

/**
 * Порт append-only event log.
 *
 * Producer получает подтверждение только после durable append. Consumer
 * продвигает offset после commit своего business effect; повторная доставка
 * допустима и подавляется eventId/idempotency на стороне consumer.
 *
 * @example `await eventLog.append({ eventId: 'evt-1', eventType: 'TradeExecuted', payload })`.
 */
export interface EventLogPort {
  /**
   * Durably добавляет immutable envelope либо отклоняет Promise.
   * @param event Версионированное событие с уникальным eventId.
   * @throws EventLogTimeout При временном отказе до durable acknowledgement.
   */
  append(event: LogEvent): Promise<void>;
  /**
   * Обрабатывает события по порядку с bounded retry/DLQ policy.
   * @param handler Идемпотентный consumer одного события.
   * @param maxRetries Максимум попыток перед quarantine/DLQ.
   */
  consume(handler: (event: LogEvent) => Promise<void>, maxRetries?: number): Promise<void>;
  /** Возвращает последний offset, committed после business effect. */
  getOffset(): number | Promise<number>;
  /** Возвращает immutable quarantine/DLQ snapshot для operator workflow. */
  getDeadLetters(): readonly LogEvent[] | Promise<readonly LogEvent[]>;
  /** Возвращает ordered immutable log snapshot для replay/reconciliation. */
  getEvents(): readonly LogEvent[] | Promise<readonly LogEvent[]>;
}
