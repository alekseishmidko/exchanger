import type { PoolClient } from 'pg';
import { Decimal } from '../../../shared-kernel';
import type { BalanceView } from '../../types';

/**
 * Repository projected balances.
 *
 * Класс изолирует SQL по `projection_balances`: чтение текущего значения,
 * применение delta из SettlementApplied и owner-isolated pagination. Decimal
 * складывается через shared `Decimal`, поэтому JSON number/floating point не
 * участвуют в расчётах.
 */
export class BalanceProjectionRepository {
  /** Применяет один posting delta к projected balance row. */
  async applyDelta(
    client: PoolClient,
    version: number,
    posting: Record<string, unknown>,
    sequence: number,
    availableDelta: string,
    reservedDelta: string,
  ): Promise<void> {
    const accountId = String(posting['accountId']);
    const assetId = String(posting['assetId']);
    const current = await client.query<{ available: string; reserved: string }>(
      `SELECT available,reserved FROM projection_balances
        WHERE projection_version=$1 AND account_id=$2 AND asset_id=$3 FOR UPDATE`,
      [version, accountId, assetId],
    );
    const available = Decimal.from(current.rows[0]?.available ?? '0')
      .add(Decimal.from(availableDelta))
      .toString();
    const reserved = Decimal.from(current.rows[0]?.reserved ?? '0')
      .add(Decimal.from(reservedDelta))
      .toString();
    await client.query(
      `INSERT INTO projection_balances
        (projection_version,account_id,asset_id,available,reserved,sequence)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (projection_version,account_id,asset_id) DO UPDATE
       SET available=EXCLUDED.available,reserved=EXCLUDED.reserved,sequence=EXCLUDED.sequence`,
      [version, accountId, assetId, available, reserved, sequence],
    );
  }

  /** Возвращает balances только account owner из authentication context. */
  async listByOwner(
    client: PoolClient,
    version: number,
    userId: string,
    offset: number,
    limit: number,
  ): Promise<readonly BalanceView[]> {
    const rows = await client.query<BalanceView>(
      `SELECT account_id AS "accountId", asset_id AS "assetId", available,
              reserved, sequence::int FROM projection_balances
        WHERE projection_version=$1 AND account_id=$2
        ORDER BY sequence, asset_id OFFSET $3 LIMIT $4`,
      [version, userId, offset, limit],
    );
    return rows.rows;
  }
}
