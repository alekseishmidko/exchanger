import type { PoolClient } from 'pg';

const PROJECTION_NAME = 'query-api';

/**
 * Repository дедупликации projection events.
 *
 * Таблица `projection_processed_events` защищает consumer от повторной доставки:
 * если event уже записан для версии, apply становится no-op и не создаёт второй
 * бизнес-эффект в read model.
 */
export class ProjectionProcessedEventRepository {
  /** Проверяет, применялся ли event к указанной projection version. */
  async exists(client: PoolClient, version: number, eventId: string): Promise<boolean> {
    const duplicate = await client.query(
      `SELECT 1 FROM projection_processed_events
        WHERE projection_name=$1 AND projection_version=$2 AND event_id=$3`,
      [PROJECTION_NAME, version, eventId],
    );
    return Boolean(duplicate.rowCount);
  }

  /** Фиксирует event ID только после успешной mutation read-model rows. */
  async record(
    client: PoolClient,
    version: number,
    eventId: string,
    sequence: number,
  ): Promise<void> {
    await client.query(
      `INSERT INTO projection_processed_events
        (projection_name,projection_version,event_id,sequence)
       VALUES ($1,$2,$3,$4)`,
      [PROJECTION_NAME, version, eventId, sequence],
    );
  }
}
