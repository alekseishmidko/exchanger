import type { PoolClient } from 'pg';
import { AccountId, AssetId, Decimal, OperationId } from '../../../shared-kernel';

/**
 * Repository reservation lifecycle.
 *
 * Reservation records append auditability around reserve/release/settlement:
 * release и settlement уменьшают `remaining_amount`, но исходная запись не
 * удаляется, что нужно для reconciliation.
 */
export class LedgerReservationRepository {
  /** Создаёт active reservation после успешного переноса available → reserved. */
  async create(
    client: PoolClient,
    id: OperationId,
    account: AccountId,
    asset: AssetId,
    amount: Decimal,
  ): Promise<void> {
    await client.query(
      `INSERT INTO reservations
        (reservation_id, operation_id, account_id, asset_id, amount, remaining_amount, status)
       VALUES ($1, $1, $2, $3, $4, $4, 'ACTIVE')`,
      [id, account, asset, amount.toString()],
    );
  }

  /** Помечает часть active reservation как released. */
  async release(
    client: PoolClient,
    operationId: OperationId,
    account: AccountId,
    asset: AssetId,
    amount: Decimal,
  ): Promise<void> {
    const reservation = await client.query(
      `UPDATE reservations
          SET remaining_amount=remaining_amount-$4,
              status=CASE WHEN remaining_amount-$4=0 THEN 'RELEASED' ELSE 'ACTIVE' END,
              release_operation_id=$3,
              updated_at=clock_timestamp()
        WHERE reservation_id = (
          SELECT reservation_id FROM reservations
           WHERE account_id=$1 AND asset_id=$2 AND status='ACTIVE' AND remaining_amount >= $4
           ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
        )`,
      [account, asset, operationId, amount.toString()],
    );
    if (reservation.rowCount !== 1) throw new Error('Active reservation does not exist');
  }

  /** Помечает часть active reservation как settled после reserved transfer. */
  async settle(
    client: PoolClient,
    account: AccountId,
    asset: AssetId,
    amount: Decimal,
  ): Promise<void> {
    const reservation = await client.query(
      `UPDATE reservations
          SET remaining_amount=remaining_amount-$3,
              status=CASE WHEN remaining_amount-$3=0 THEN 'SETTLED' ELSE 'ACTIVE' END,
              updated_at=clock_timestamp()
        WHERE reservation_id = (
          SELECT reservation_id FROM reservations
           WHERE account_id=$1 AND asset_id=$2 AND status='ACTIVE' AND remaining_amount >= $3
           ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
        )`,
      [account, asset, amount.toString()],
    );
    if (reservation.rowCount !== 1) throw new Error('Active reservation does not exist');
  }
}
