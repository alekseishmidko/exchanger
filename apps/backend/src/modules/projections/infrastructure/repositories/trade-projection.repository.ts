import type { PoolClient } from 'pg';
import type { ProjectionEvent, TradeView } from '../../types';

/**
 * Repository read-model истории сделок.
 *
 * Хранит только публичные trade snapshots и фильтрует чтение по participants.
 * Финансовые postings и ledger details в эту таблицу не попадают.
 */
export class TradeProjectionRepository {
  /** Идемпотентно вставляет trade snapshot; duplicate trade не меняет row. */
  async insert(client: PoolClient, version: number, event: ProjectionEvent): Promise<void> {
    const payload = event.payload;
    await client.query(
      `INSERT INTO projection_trades
        (projection_version,trade_id,instrument_id,user_ids,maker_order_id,taker_order_id,quantity,price,sequence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
      [
        version,
        String(payload['tradeId']),
        String(payload['instrumentId']),
        [String(payload['makerUserId']), String(payload['takerUserId'])],
        String(payload['makerOrderId']),
        String(payload['takerOrderId']),
        String(payload['quantity']),
        String(payload['price']),
        event.sequence,
      ],
    );
  }

  /** Возвращает сделки только если userId находится в participants. */
  async listByUser(
    client: PoolClient,
    version: number,
    userId: string,
    offset: number,
    limit: number,
  ): Promise<readonly TradeView[]> {
    const rows = await client.query<TradeView>(
      `SELECT trade_id AS "tradeId", instrument_id AS "instrumentId",
              user_ids AS "userIds", maker_order_id AS "makerOrderId",
              taker_order_id AS "takerOrderId", quantity, price, sequence::int
         FROM projection_trades WHERE projection_version=$1 AND $2=ANY(user_ids)
         ORDER BY sequence, trade_id OFFSET $3 LIMIT $4`,
      [version, userId, offset, limit],
    );
    return rows.rows;
  }
}
