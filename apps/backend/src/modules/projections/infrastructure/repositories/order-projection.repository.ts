import type { PoolClient } from 'pg';
import type { OrderView, ProjectionEvent } from '../../types';

/**
 * Repository read-model истории заявок.
 *
 * Отвечает только за таблицу `projection_orders`: upsert статуса заявки и
 * owner-isolated чтение страниц. Mapping берёт только публичный payload event и
 * не раскрывает внутренние aggregate/matching structures.
 */
export class OrderProjectionRepository {
  /** Upsert заявки в рамках конкретной projection version. */
  async upsert(
    client: PoolClient,
    version: number,
    event: ProjectionEvent,
    status: OrderView['status'],
    remainingQuantity: string,
  ): Promise<void> {
    const payload = event.payload;
    await client.query(
      `INSERT INTO projection_orders
        (projection_version,order_id,user_id,account_id,instrument_id,status,remaining_quantity,updated_at_sequence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (projection_version,order_id) DO UPDATE
       SET status=EXCLUDED.status, remaining_quantity=EXCLUDED.remaining_quantity,
           updated_at_sequence=EXCLUDED.updated_at_sequence`,
      [
        version,
        String(payload['orderId']),
        String(payload['userId']),
        String(payload['accountId']),
        String(payload['instrumentId']),
        status,
        remainingQuantity,
        event.sequence,
      ],
    );
  }

  /** Возвращает заявки только authenticated owner с offset pagination. */
  async listByUser(
    client: PoolClient,
    version: number,
    userId: string,
    offset: number,
    limit: number,
  ): Promise<readonly OrderView[]> {
    const rows = await client.query<OrderView>(
      `SELECT order_id AS "orderId", user_id AS "userId", account_id AS "accountId",
              instrument_id AS "instrumentId", status,
              remaining_quantity AS "remainingQuantity",
              updated_at_sequence::int AS "updatedAtSequence"
         FROM projection_orders WHERE projection_version=$1 AND user_id=$2
         ORDER BY updated_at_sequence, order_id OFFSET $3 LIMIT $4`,
      [version, userId, offset, limit],
    );
    return rows.rows;
  }
}
