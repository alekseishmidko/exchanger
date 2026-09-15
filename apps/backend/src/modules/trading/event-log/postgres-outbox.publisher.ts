import { Inject } from '@nestjs/common';
import type { QueryResultRow } from 'pg';
import { POSTGRES_TRANSACTION, PostgresTransactionManager } from '../../../infrastructure/postgres';
import type { LogEvent } from './event-log';

type PublishRow = QueryResultRow & {
  event_offset: string;
  event_id: string;
  event_type: string;
  payload: unknown;
  correlation_id: string | null;
  causation_id: string | null;
  attempts: number;
};

/** Функция доставки outbox event во внешний broker/fan-out transport. */
export type OutboxDelivery = (event: LogEvent) => Promise<void>;

/**
 * Crash-safe at-least-once publisher PostgreSQL outbox.
 *
 * Строка блокируется через `FOR UPDATE SKIP LOCKED`, поэтому replicas не
 * публикуют её одновременно. `published_at` ставится после acknowledgement в
 * той же transaction. Crash после delivery и до commit допускает повторную
 * доставку; downstream обязан дедуплицировать eventId.
 */
export class PostgresOutboxPublisher {
  /**
   * Создаёт publisher поверх shared transaction manager.
   * Несколько экземпляров безопасно работают параллельно благодаря
   * `FOR UPDATE SKIP LOCKED` и никогда не передают connection наружу.
   */
  constructor(
    @Inject(POSTGRES_TRANSACTION) private readonly transactions: PostgresTransactionManager,
  ) {}

  /**
   * Публикует не более `batchSize` готовых событий.
   * @param deliver Broker/fan-out callback, завершающийся после acknowledgement.
   * @param batchSize Верхняя граница работы одного polling tick; default — 100.
   * @returns Число событий, получивших acknowledgement и committed mark.
   */
  async publishBatch(deliver: OutboxDelivery, batchSize = 100): Promise<number> {
    let published = 0;
    for (let index = 0; index < batchSize; index += 1) {
      const outcome = await this.publishOne(deliver);
      if (outcome === 'empty') break;
      if (outcome === 'published') published += 1;
    }
    return published;
  }

  /** Публикует одну locked строку либо сообщает об отсутствии backlog. */
  private publishOne(deliver: OutboxDelivery): Promise<'published' | 'failed' | 'empty'> {
    return this.transactions.run(async (client) => {
      const result = await client.query<PublishRow>(
        `SELECT * FROM outbox_events
          WHERE published_at IS NULL AND next_attempt_at <= clock_timestamp()
          ORDER BY event_offset FOR UPDATE SKIP LOCKED LIMIT 1`,
      );
      const row = result.rows[0];
      if (!row) return 'empty';
      try {
        await deliver({
          eventId: row.event_id,
          eventType: row.event_type,
          payload: row.payload,
          ...(row.correlation_id ? { correlationId: row.correlation_id } : {}),
          ...(row.causation_id ? { causationId: row.causation_id } : {}),
        });
        await client.query(
          'UPDATE outbox_events SET published_at=clock_timestamp(), attempts=attempts+1 WHERE event_offset=$1',
          [row.event_offset],
        );
        return 'published';
      } catch (error) {
        const delaySeconds = Math.min(60, 2 ** Math.min(row.attempts, 5));
        await client.query(
          `UPDATE outbox_events
              SET attempts=attempts+1,
                  next_attempt_at=clock_timestamp()+($2::text || ' seconds')::interval,
                  last_error_code=$3
            WHERE event_offset=$1`,
          [row.event_offset, delaySeconds, error instanceof Error ? error.name : 'UNKNOWN_ERROR'],
        );
        return 'failed';
      }
    });
  }
}
