import { Inject } from '@nestjs/common';
import type { QueryResultRow } from 'pg';
import { POSTGRES_TRANSACTION, PostgresTransactionManager } from '../../../infrastructure/postgres';
import { canonicalJson } from '../../../infrastructure/postgres/postgres-json';
import type { LogEvent } from './event-log';
import type { EventLogPort } from './event-log.port';

type OutboxRow = QueryResultRow & {
  event_offset: string;
  event_id: string;
  event_type: string;
  payload: unknown;
  correlation_id: string | null;
  causation_id: string | null;
};

/**
 * PostgreSQL outbox adapter с transactional consumer offsets и DLQ.
 *
 * `append` присоединяется к активной producer transaction. Consumer блокирует
 * следующую строку, вызывает handler в том же transaction context и только
 * после успешного business commit продвигает offset. Crash до commit приводит к
 * redelivery, а unique processed event подавляет повторный effect.
 */
export class PostgresEventLogAdapter implements EventLogPort {
  /**
   * Создаёт adapter для одного устойчивого consumer name.
   * @param transactions Общая PostgreSQL transaction boundary.
   * @param consumerName Стабильное имя offset/DLQ ownership.
   */
  constructor(
    @Inject(POSTGRES_TRANSACTION) private readonly transactions: PostgresTransactionManager,
    private readonly consumerName = 'exchange-backend',
  ) {}

  /**
   * Идемпотентно добавляет событие в outbox текущей transaction.
   * Тот же event ID и payload считается retry; повтор ID с другим содержимым
   * отклоняется, чтобы не подменить уже опубликованное событие.
   */
  append(event: LogEvent): Promise<void> {
    return this.transactions.run(async (client) => {
      const inserted = await client.query(
        `INSERT INTO outbox_events
          (event_id, aggregate_type, aggregate_id, event_type, payload, correlation_id, causation_id)
         VALUES ($1, 'event', $1, $2, $3::jsonb, $4, $5)
         ON CONFLICT (event_id) DO NOTHING`,
        [
          event.eventId,
          event.eventType,
          JSON.stringify(event.payload),
          event.correlationId ?? null,
          event.causationId ?? null,
        ],
      );
      if (inserted.rowCount === 0) {
        const previous = await client.query<{ event_type: string; payload: unknown }>(
          'SELECT event_type, payload FROM outbox_events WHERE event_id=$1',
          [event.eventId],
        );
        const row = previous.rows[0];
        if (
          !row ||
          row.event_type !== event.eventType ||
          canonicalJson(row.payload) !== canonicalJson(event.payload)
        ) {
          throw new Error('EVENT_ID_REUSED');
        }
      }
    });
  }

  /**
   * Обрабатывает доступный backlog по порядку с bounded retry и quarantine.
   * @param handler Business effect, выполняемый в той же PostgreSQL transaction.
   * @param maxRetries Максимум попыток до DLQ; default — три.
   */
  async consume(handler: (event: LogEvent) => Promise<void>, maxRetries = 3): Promise<void> {
    while (true) {
      const next = await this.nextOffset();
      if (next === null) return;
      let handled = false;
      let lastError: unknown;
      for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
        try {
          await this.process(next, handler);
          handled = true;
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (!handled) await this.quarantine(next, maxRetries, lastError);
    }
  }

  /** Возвращает durable committed offset текущего consumer, либо `0` до первого effect. */
  getOffset(): Promise<number> {
    return this.transactions.run(async (client) => {
      const result = await client.query<{ committed_offset: string }>(
        'SELECT committed_offset FROM consumer_offsets WHERE consumer_name=$1',
        [this.consumerName],
      );
      return Number(result.rows[0]?.committed_offset ?? 0);
    });
  }

  /** Возвращает immutable DLQ envelopes в порядке исходного offset. */
  getDeadLetters(): Promise<readonly LogEvent[]> {
    return this.transactions.run(async (client) => {
      const result = await client.query<OutboxRow>(
        `SELECT source_offset AS event_offset, event_id, event_type, payload,
                NULL::text AS correlation_id, NULL::text AS causation_id
           FROM dead_letter_events WHERE consumer_name=$1 ORDER BY source_offset`,
        [this.consumerName],
      );
      return result.rows.map((row) => this.map(row));
    });
  }

  /** Возвращает полный ordered outbox snapshot для replay/reconciliation. */
  getEvents(): Promise<readonly LogEvent[]> {
    return this.transactions.run(async (client) => {
      const result = await client.query<OutboxRow>(
        'SELECT * FROM outbox_events ORDER BY event_offset',
      );
      return result.rows.map((row) => this.map(row));
    });
  }

  /**
   * Создаёт новое replay-событие из quarantined payload, не изменяя оригинал.
   *
   * Один DLQ record разрешено replay-нуть один раз данным методом. Operator ID
   * сохраняется отдельно, а исходный event остаётся неизменяемым для аудита.
   *
   * @param eventId Идентификатор quarantined события.
   * @param operatorId Проверенная служебная identity оператора.
   * @returns Идентификатор нового outbox event.
   */
  replayDeadLetter(eventId: string, operatorId: string): Promise<string> {
    return this.transactions.run(async (client) => {
      const result = await client.query<{
        event_type: string;
        payload: unknown;
        replayed_at: Date | null;
      }>(
        `SELECT event_type, payload, replayed_at FROM dead_letter_events
          WHERE consumer_name=$1 AND event_id=$2 FOR UPDATE`,
        [this.consumerName, eventId],
      );
      const row = result.rows[0];
      if (!row) throw new Error('DEAD_LETTER_EVENT_NOT_FOUND');
      if (row.replayed_at) throw new Error('DEAD_LETTER_EVENT_ALREADY_REPLAYED');
      const replayEventId = `replay-${this.consumerName}-${eventId}`;
      await client.query(
        `INSERT INTO outbox_events
          (event_id, aggregate_type, aggregate_id, event_type, payload, causation_id)
         VALUES ($1, 'dead-letter-replay', $2, $3, $4::jsonb, $2)`,
        [replayEventId, eventId, row.event_type, JSON.stringify(row.payload)],
      );
      await client.query(
        `UPDATE dead_letter_events
            SET replayed_at=clock_timestamp(), replayed_by=$3
          WHERE consumer_name=$1 AND event_id=$2`,
        [this.consumerName, eventId, operatorId],
      );
      return replayEventId;
    });
  }

  /** Находит следующий offset после durable checkpoint. */
  private nextOffset(): Promise<number | null> {
    return this.transactions.run(async (client) => {
      const result = await client.query<{ event_offset: string }>(
        `SELECT event_offset FROM outbox_events
          WHERE event_offset > COALESCE((SELECT committed_offset FROM consumer_offsets WHERE consumer_name=$1), 0)
          ORDER BY event_offset LIMIT 1`,
        [this.consumerName],
      );
      return result.rows[0] ? Number(result.rows[0].event_offset) : null;
    });
  }

  /** Фиксирует handler effect, processed event и offset одной transaction. */
  private process(offset: number, handler: (event: LogEvent) => Promise<void>): Promise<void> {
    return this.transactions.run(async (client) => {
      const result = await client.query<OutboxRow>(
        'SELECT * FROM outbox_events WHERE event_offset=$1 FOR UPDATE',
        [offset],
      );
      const row = result.rows[0];
      if (!row) return;
      const duplicate = await client.query(
        `INSERT INTO processed_events (consumer_name, event_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [this.consumerName, row.event_id],
      );
      if (duplicate.rowCount === 1) await handler(this.map(row));
      await this.commitOffset(client, offset);
    });
  }

  /** После исчерпания retry сохраняет poison event и двигает offset атомарно. */
  private quarantine(offset: number, attempts: number, error: unknown): Promise<void> {
    return this.transactions.run(async (client) => {
      const result = await client.query<OutboxRow>(
        'SELECT * FROM outbox_events WHERE event_offset=$1 FOR UPDATE',
        [offset],
      );
      const row = result.rows[0];
      if (!row) return;
      await client.query(
        `INSERT INTO dead_letter_events
          (consumer_name, event_id, source_offset, event_type, payload, attempts, error_code)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
         ON CONFLICT DO NOTHING`,
        [
          this.consumerName,
          row.event_id,
          offset,
          row.event_type,
          JSON.stringify(row.payload),
          attempts,
          this.errorCode(error),
        ],
      );
      await this.commitOffset(client, offset);
    });
  }

  /** Upsert offset запрещает движение checkpoint назад. */
  private async commitOffset(
    client: ReturnType<PostgresTransactionManager['currentClient']>,
    offset: number,
  ) {
    await client.query(
      `INSERT INTO consumer_offsets (consumer_name, committed_offset) VALUES ($1, $2)
       ON CONFLICT (consumer_name) DO UPDATE
       SET committed_offset=GREATEST(consumer_offsets.committed_offset, EXCLUDED.committed_offset),
           updated_at=clock_timestamp()`,
      [this.consumerName, offset],
    );
  }

  /** Маппит outbox row в публичный immutable event envelope. */
  private map(row: OutboxRow): LogEvent {
    return {
      eventId: row.event_id,
      eventType: row.event_type,
      payload: row.payload,
      ...(row.correlation_id ? { correlationId: row.correlation_id } : {}),
      ...(row.causation_id ? { causationId: row.causation_id } : {}),
    };
  }

  /** Возвращает только безопасный класс ошибки, без message/stack. */
  private errorCode(error: unknown): string {
    return error instanceof Error ? error.name : 'UNKNOWN_ERROR';
  }
}
