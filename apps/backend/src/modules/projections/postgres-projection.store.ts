import { BadRequestException, Inject } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { POSTGRES_TRANSACTION, PostgresTransactionManager } from '../../infrastructure/postgres';
import { Decimal } from '../shared-kernel';
import type {
  BalanceView,
  OrderView,
  ProjectionEvent,
  ProjectionMetrics,
  ProjectionPage,
  TradeView,
} from './projection';
import type { ProjectionStorePort } from './projection.port';

/**
 * PostgreSQL read-model adapter с transactional offset и versioned shadow rebuild.
 *
 * Live apply блокирует ACTIVE version, проверяет duplicate/gap, изменяет модель,
 * вставляет event ID и двигает applied sequence одним commit. Rebuild пишет в
 * новую BUILDING version и атомарно переключает ACTIVE pointer после полного
 * replay, поэтому query API никогда не видит частично построенную модель.
 */
export class PostgresProjectionStore implements ProjectionStorePort {
  /** Создаёт adapter поверх shared consumer transaction manager. */
  constructor(
    @Inject(POSTGRES_TRANSACTION) private readonly transactions: PostgresTransactionManager,
  ) {}

  /** Идемпотентно применяет следующее событие и offset в одной transaction. */
  apply(event: ProjectionEvent): Promise<void> {
    return this.transactions.run(async (client) => {
      const version = await this.activeVersion(client, true);
      await this.applyToVersion(client, version, event);
    });
  }

  /**
   * Строит shadow version параллельно live consumer и выполняет короткий swap.
   *
   * Replay не блокирует ACTIVE row: публичные queries и live apply продолжают
   * использовать прежнюю версию. Перед переключением adapter берёт lock и
   * сравнивает её sequence с tail входного stream. Если live consumer успел
   * уйти вперёд, BUILDING version удаляется, а caller должен повторить rebuild с
   * актуальным stream — частичная или устаревшая модель никогда не публикуется.
   *
   * @param events Полный непрерывный stream от sequence 1 до captured watermark.
   * @throws Error С кодом `PROJECTION_REBUILD_STALE`, если live sequence изменился.
   *
   * @example
   * `await store.rebuild(eventsThroughSequence42)` публикует новую version только
   * если ACTIVE projection всё ещё находится на sequence 42 в момент swap.
   */
  async rebuild(events: readonly ProjectionEvent[]): Promise<void> {
    const { active, next } = await this.transactions.run(async (client) => {
      const activeVersion = await this.activeVersion(client);
      const version = await client.query<{ next_version: string }>(
        "SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM projection_versions WHERE projection_name='query-api'",
      );
      const nextVersion = Number(version.rows[0]?.next_version ?? activeVersion + 1);
      await client.query(
        `INSERT INTO projection_versions
          (projection_name,version,schema_version,status,source_sequence)
         VALUES ('query-api',$1,1,'BUILDING',$2)`,
        [nextVersion, events.at(-1)?.sequence ?? 0],
      );
      for (const event of events) {
        await this.applyToVersion(client, nextVersion, event, 'BUILDING');
      }
      return { active: activeVersion, next: nextVersion };
    });

    try {
      await this.transactions.run(async (client) => {
        const current = await this.activeVersion(client, true);
        const expectedSequence = events.at(-1)?.sequence ?? 0;
        const state = await client.query<{ applied_sequence: string }>(
          `SELECT applied_sequence FROM projection_versions
            WHERE projection_name='query-api' AND version=$1 AND status='ACTIVE'`,
          [current],
        );
        if (
          current !== active ||
          Number(state.rows[0]?.applied_sequence ?? -1) !== expectedSequence
        ) {
          throw new Error('PROJECTION_REBUILD_STALE');
        }
        await client.query(
          "UPDATE projection_versions SET status='RETIRED' WHERE projection_name='query-api' AND version=$1",
          [active],
        );
        await client.query(
          `UPDATE projection_versions SET status='ACTIVE', activated_at=clock_timestamp()
            WHERE projection_name='query-api' AND version=$1 AND status='BUILDING'`,
          [next],
        );
      });
    } catch (error) {
      await this.transactions.run(async (client) => {
        await client.query(
          "DELETE FROM projection_versions WHERE projection_name='query-api' AND version=$1 AND status='BUILDING'",
          [next],
        );
      });
      throw error;
    }
  }

  /** Возвращает owner-isolated order page активной projection version. */
  getOrders(userId: string, limit = 50, cursor?: string): Promise<ProjectionPage<OrderView>> {
    return this.transactions.run(async (client) => {
      const version = await this.activeVersion(client);
      const rows = await client.query<OrderView>(
        `SELECT order_id AS "orderId", user_id AS "userId", account_id AS "accountId",
                instrument_id AS "instrumentId", status,
                remaining_quantity AS "remainingQuantity",
                updated_at_sequence::int AS "updatedAtSequence"
           FROM projection_orders WHERE projection_version=$1 AND user_id=$2
           ORDER BY updated_at_sequence, order_id OFFSET $3 LIMIT $4`,
        [version, userId, this.cursor(cursor), limit + 1],
      );
      return this.page(rows.rows, limit, cursor);
    });
  }

  /** Возвращает сделки только если authenticated user входит в participants. */
  getTrades(userId: string, limit = 50, cursor?: string): Promise<ProjectionPage<TradeView>> {
    return this.transactions.run(async (client) => {
      const version = await this.activeVersion(client);
      const rows = await client.query<TradeView>(
        `SELECT trade_id AS "tradeId", instrument_id AS "instrumentId",
                user_ids AS "userIds", maker_order_id AS "makerOrderId",
                taker_order_id AS "takerOrderId", quantity, price, sequence::int
           FROM projection_trades WHERE projection_version=$1 AND $2=ANY(user_ids)
           ORDER BY sequence, trade_id OFFSET $3 LIMIT $4`,
        [version, userId, this.cursor(cursor), limit + 1],
      );
      return this.page(rows.rows, limit, cursor);
    });
  }

  /** Возвращает balance rows только account owner из authentication context. */
  getBalances(userId: string, limit = 50, cursor?: string): Promise<ProjectionPage<BalanceView>> {
    return this.transactions.run(async (client) => {
      const version = await this.activeVersion(client);
      const rows = await client.query<BalanceView>(
        `SELECT account_id AS "accountId", asset_id AS "assetId", available,
                reserved, sequence::int FROM projection_balances
          WHERE projection_version=$1 AND account_id=$2
          ORDER BY sequence, asset_id OFFSET $3 LIMIT $4`,
        [version, userId, this.cursor(cursor), limit + 1],
      );
      return this.page(rows.rows, limit, cursor);
    });
  }

  /** Читает schema/version lag без unbounded labels. */
  getMetrics(): Promise<ProjectionMetrics> {
    return this.transactions.run(async (client) => {
      const result = await client.query<{
        schema_version: number;
        applied_sequence: string;
        source_sequence: string;
      }>(
        "SELECT schema_version, applied_sequence, source_sequence FROM projection_versions WHERE projection_name='query-api' AND status='ACTIVE'",
      );
      const row = result.rows[0];
      const appliedSequence = Number(row?.applied_sequence ?? 0);
      const sourceSequence = Number(row?.source_sequence ?? 0);
      return {
        schemaVersion: row?.schema_version ?? 1,
        appliedSequence,
        sourceSequence,
        lag: Math.max(0, sourceSequence - appliedSequence),
      };
    });
  }

  /** Применяет event к указанной live/shadow version и фиксирует checkpoint. */
  private async applyToVersion(
    client: PoolClient,
    version: number,
    event: ProjectionEvent,
    requiredStatus: 'ACTIVE' | 'BUILDING' = 'ACTIVE',
  ): Promise<void> {
    const state = await client.query<{ applied_sequence: string }>(
      `SELECT applied_sequence FROM projection_versions
        WHERE projection_name='query-api' AND version=$1 AND status=$2 FOR UPDATE`,
      [version, requiredStatus],
    );
    const applied = Number(state.rows[0]?.applied_sequence ?? -1);
    if (applied < 0) throw new Error('PROJECTION_VERSION_NOT_AVAILABLE');
    const duplicate = await client.query(
      `SELECT 1 FROM projection_processed_events
        WHERE projection_name='query-api' AND projection_version=$1 AND event_id=$2`,
      [version, event.eventId],
    );
    if (duplicate.rowCount) return;
    if (event.sequence !== applied + 1) {
      throw new BadRequestException({
        code: 'PROJECTION_SEQUENCE_GAP',
        message: 'Projection sequence gap detected',
      });
    }
    await this.mutate(client, version, event);
    await client.query(
      `INSERT INTO projection_processed_events
        (projection_name,projection_version,event_id,sequence)
       VALUES ('query-api',$1,$2,$3)`,
      [version, event.eventId, event.sequence],
    );
    await client.query(
      `UPDATE projection_versions SET applied_sequence=$2,
          source_sequence=GREATEST(source_sequence,$2)
        WHERE projection_name='query-api' AND version=$1`,
      [version, event.sequence],
    );
  }

  /** Маппит public event payload в version-scoped read model rows. */
  private async mutate(client: PoolClient, version: number, event: ProjectionEvent): Promise<void> {
    const payload = event.payload;
    if (
      event.eventType === 'OrderAccepted' ||
      event.eventType === 'OrderRejected' ||
      event.eventType === 'OrderCancelled'
    ) {
      const status =
        event.eventType === 'OrderAccepted'
          ? 'ACCEPTED'
          : event.eventType === 'OrderRejected'
            ? 'REJECTED'
            : 'CANCELLED';
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
          this.scalar(payload['remainingQuantity'], '0'),
          event.sequence,
        ],
      );
      return;
    }
    if (event.eventType === 'TradeExecuted') {
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
      return;
    }
    const postings = payload['postings'];
    if (!Array.isArray(postings)) throw new Error('PROJECTION_INVALID_EVENT');
    for (const posting of postings as Array<Record<string, unknown>>) {
      const accountId = String(posting['accountId']);
      const assetId = String(posting['assetId']);
      const current = await client.query<{ available: string; reserved: string }>(
        `SELECT available,reserved FROM projection_balances
          WHERE projection_version=$1 AND account_id=$2 AND asset_id=$3 FOR UPDATE`,
        [version, accountId, assetId],
      );
      const available = Decimal.from(current.rows[0]?.available ?? '0')
        .add(Decimal.from(this.scalar(posting['availableDelta'], '0')))
        .toString();
      const reserved = Decimal.from(current.rows[0]?.reserved ?? '0')
        .add(Decimal.from(this.scalar(posting['reservedDelta'], '0')))
        .toString();
      await client.query(
        `INSERT INTO projection_balances
          (projection_version,account_id,asset_id,available,reserved,sequence)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (projection_version,account_id,asset_id) DO UPDATE
         SET available=EXCLUDED.available,reserved=EXCLUDED.reserved,sequence=EXCLUDED.sequence`,
        [version, accountId, assetId, available, reserved, event.sequence],
      );
    }
  }

  /** Возвращает ACTIVE version и при apply блокирует pointer до commit. */
  private async activeVersion(client: PoolClient, lock = false): Promise<number> {
    const result = await client.query<{ version: string }>(
      `SELECT version FROM projection_versions
        WHERE projection_name='query-api' AND status='ACTIVE'${lock ? ' FOR UPDATE' : ''}`,
    );
    if (!result.rows[0]) throw new Error('PROJECTION_NOT_READY');
    return Number(result.rows[0].version);
  }

  /** Валидирует numeric cursor и не принимает отрицательное смещение. */
  private cursor(value?: string): number {
    const cursor = Number(value ?? 0);
    if (!Number.isInteger(cursor) || cursor < 0) throw new Error('PAGINATION_INVALID');
    return cursor;
  }

  /** Формирует bounded page и следующий opaque offset cursor. */
  private page<T>(rows: readonly T[], limit: number, cursor?: string): ProjectionPage<T> {
    const items = rows.slice(0, limit);
    return {
      items,
      nextCursor: rows.length > limit ? String(this.cursor(cursor) + items.length) : null,
    };
  }

  /** Преобразует только JSON scalar в строку и запрещает `[object Object]`. */
  private scalar(value: unknown, fallback: string): string {
    if (value === undefined || value === null) return fallback;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
      return `${value}`;
    }
    throw new Error('PROJECTION_INVALID_SCALAR');
  }
}
