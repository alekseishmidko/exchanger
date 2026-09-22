import { BadRequestException, Inject } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { POSTGRES_TRANSACTION, PostgresTransactionManager } from '../../../infrastructure/postgres';
import type {
  BalanceView,
  OrderView,
  ProjectionEvent,
  ProjectionMetrics,
  ProjectionPage,
  TradeView,
} from '../types';
import type { ProjectionStorePort } from '../ports/projection.port';
import {
  BalanceProjectionRepository,
  OrderProjectionRepository,
  ProjectionProcessedEventRepository,
  ProjectionVersionRepository,
  TradeProjectionRepository,
} from './repositories';

/**
 * PostgreSQL read-model adapter с transactional offset и versioned shadow rebuild.
 *
 * Live apply блокирует ACTIVE version, проверяет duplicate/gap, изменяет модель,
 * вставляет event ID и двигает applied sequence одним commit. Rebuild пишет в
 * новую BUILDING version и атомарно переключает ACTIVE pointer после полного
 * replay, поэтому query API никогда не видит частично построенную модель.
 */
export class PostgresProjectionStore implements ProjectionStorePort {
  private readonly versions = new ProjectionVersionRepository();
  private readonly processedEvents = new ProjectionProcessedEventRepository();
  private readonly orders = new OrderProjectionRepository();
  private readonly trades = new TradeProjectionRepository();
  private readonly balances = new BalanceProjectionRepository();

  /** Создаёт adapter поверх shared consumer transaction manager. */
  constructor(
    @Inject(POSTGRES_TRANSACTION) private readonly transactions: PostgresTransactionManager,
  ) {}

  /** Идемпотентно применяет следующее событие и offset в одной transaction. */
  apply(event: ProjectionEvent): Promise<void> {
    return this.transactions.run(async (client) => {
      const version = await this.versions.activeVersion(client, true);
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
      const activeVersion = await this.versions.activeVersion(client);
      const nextVersion = await this.versions.createBuildingVersion(
        client,
        events.at(-1)?.sequence ?? 0,
      );
      for (const event of events) {
        await this.applyToVersion(client, nextVersion, event, 'BUILDING');
      }
      return { active: activeVersion, next: nextVersion };
    });

    try {
      await this.transactions.run(async (client) => {
        await this.versions.swapBuildingToActive(
          client,
          active,
          next,
          events.at(-1)?.sequence ?? 0,
        );
      });
    } catch (error) {
      await this.transactions.run(async (client) => {
        await this.versions.deleteBuilding(client, next);
      });
      throw error;
    }
  }

  /** Возвращает owner-isolated order page активной projection version. */
  getOrders(userId: string, limit = 50, cursor?: string): Promise<ProjectionPage<OrderView>> {
    return this.transactions.run(async (client) => {
      const version = await this.versions.activeVersion(client);
      const rows = await this.orders.listByUser(
        client,
        version,
        userId,
        this.cursor(cursor),
        limit + 1,
      );
      return this.page(rows, limit, cursor);
    });
  }

  /** Возвращает сделки только если authenticated user входит в participants. */
  getTrades(userId: string, limit = 50, cursor?: string): Promise<ProjectionPage<TradeView>> {
    return this.transactions.run(async (client) => {
      const version = await this.versions.activeVersion(client);
      const rows = await this.trades.listByUser(
        client,
        version,
        userId,
        this.cursor(cursor),
        limit + 1,
      );
      return this.page(rows, limit, cursor);
    });
  }

  /** Возвращает balance rows только account owner из authentication context. */
  getBalances(userId: string, limit = 50, cursor?: string): Promise<ProjectionPage<BalanceView>> {
    return this.transactions.run(async (client) => {
      const version = await this.versions.activeVersion(client);
      const rows = await this.balances.listByOwner(
        client,
        version,
        userId,
        this.cursor(cursor),
        limit + 1,
      );
      return this.page(rows, limit, cursor);
    });
  }

  /** Читает schema/version lag без unbounded labels. */
  getMetrics(): Promise<ProjectionMetrics> {
    return this.transactions.run((client) => this.versions.metrics(client));
  }

  /** Применяет event к указанной live/shadow version и фиксирует checkpoint. */
  private async applyToVersion(
    client: PoolClient,
    version: number,
    event: ProjectionEvent,
    requiredStatus: 'ACTIVE' | 'BUILDING' = 'ACTIVE',
  ): Promise<void> {
    const applied = await this.versions.lockVersionSequence(client, version, requiredStatus);
    if (await this.processedEvents.exists(client, version, event.eventId)) return;
    if (event.sequence !== applied + 1) {
      throw new BadRequestException({
        code: 'PROJECTION_SEQUENCE_GAP',
        message: 'Projection sequence gap detected',
      });
    }
    await this.mutate(client, version, event);
    await this.processedEvents.record(client, version, event.eventId, event.sequence);
    await this.versions.markApplied(client, version, event.sequence);
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
      await this.orders.upsert(
        client,
        version,
        event,
        status,
        this.scalar(payload['remainingQuantity'], '0'),
      );
      return;
    }
    if (event.eventType === 'TradeExecuted') {
      await this.trades.insert(client, version, event);
      return;
    }
    const postings = payload['postings'];
    if (!Array.isArray(postings)) throw new Error('PROJECTION_INVALID_EVENT');
    for (const posting of postings as Array<Record<string, unknown>>) {
      await this.balances.applyDelta(
        client,
        version,
        posting,
        event.sequence,
        this.scalar(posting['availableDelta'], '0'),
        this.scalar(posting['reservedDelta'], '0'),
      );
    }
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
