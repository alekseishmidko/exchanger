import type { PoolClient } from 'pg';
import type { ProjectionMetrics } from '../../types';

const PROJECTION_NAME = 'query-api';

/**
 * Repository версий read-model projection.
 *
 * Класс инкапсулирует таблицу `projection_versions`: поиск ACTIVE версии,
 * создание BUILDING версии для rebuild, проверку high watermark и атомарный
 * swap. `PostgresProjectionStore` оставляет за собой transaction boundary, а
 * repository отвечает только за SQL конкретной сущности version pointer.
 */
export class ProjectionVersionRepository {
  /**
   * Возвращает ACTIVE version и опционально блокирует pointer до commit.
   *
   * @param client Открытый transaction client.
   * @param lock Включает `FOR UPDATE`, когда caller меняет projection state.
   * @throws Error Если projection ещё не инициализирована migration-ом.
   */
  async activeVersion(client: PoolClient, lock = false): Promise<number> {
    const result = await client.query<{ version: string }>(
      `SELECT version FROM projection_versions
        WHERE projection_name=$1 AND status='ACTIVE'${lock ? ' FOR UPDATE' : ''}`,
      [PROJECTION_NAME],
    );
    if (!result.rows[0]) throw new Error('PROJECTION_NOT_READY');
    return Number(result.rows[0].version);
  }

  /**
   * Возвращает applied sequence выбранной версии и проверяет её статус.
   *
   * @param status Защищает live apply от записи в retired/building версию.
   */
  async lockVersionSequence(
    client: PoolClient,
    version: number,
    status: 'ACTIVE' | 'BUILDING',
  ): Promise<number> {
    const state = await client.query<{ applied_sequence: string }>(
      `SELECT applied_sequence FROM projection_versions
        WHERE projection_name=$1 AND version=$2 AND status=$3 FOR UPDATE`,
      [PROJECTION_NAME, version, status],
    );
    const applied = Number(state.rows[0]?.applied_sequence ?? -1);
    if (applied < 0) throw new Error('PROJECTION_VERSION_NOT_AVAILABLE');
    return applied;
  }

  /**
   * Создаёт новую BUILDING версию для shadow rebuild.
   *
   * @param sourceSequence Captured watermark журнала, до которого строится shadow.
   */
  async createBuildingVersion(client: PoolClient, sourceSequence: number): Promise<number> {
    const version = await client.query<{ next_version: string }>(
      `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
         FROM projection_versions WHERE projection_name=$1`,
      [PROJECTION_NAME],
    );
    const nextVersion = Number(version.rows[0]?.next_version ?? 1);
    await client.query(
      `INSERT INTO projection_versions
        (projection_name,version,schema_version,status,source_sequence)
       VALUES ($1,$2,1,'BUILDING',$3)`,
      [PROJECTION_NAME, nextVersion, sourceSequence],
    );
    return nextVersion;
  }

  /** Продвигает applied/source sequence после успешного применения event. */
  async markApplied(client: PoolClient, version: number, sequence: number): Promise<void> {
    await client.query(
      `UPDATE projection_versions SET applied_sequence=$3,
          source_sequence=GREATEST(source_sequence,$3)
        WHERE projection_name=$1 AND version=$2`,
      [PROJECTION_NAME, version, sequence],
    );
  }

  /**
   * Атомарно публикует BUILDING версию вместо ACTIVE.
   *
   * Swap разрешён только если live projection не ушла дальше captured watermark.
   * Так API никогда не увидит устаревшую shadow-модель.
   */
  async swapBuildingToActive(
    client: PoolClient,
    expectedActive: number,
    building: number,
    expectedSequence: number,
  ): Promise<void> {
    const current = await this.activeVersion(client, true);
    const state = await client.query<{ applied_sequence: string }>(
      `SELECT applied_sequence FROM projection_versions
        WHERE projection_name=$1 AND version=$2 AND status='ACTIVE'`,
      [PROJECTION_NAME, current],
    );
    if (
      current !== expectedActive ||
      Number(state.rows[0]?.applied_sequence ?? -1) !== expectedSequence
    ) {
      throw new Error('PROJECTION_REBUILD_STALE');
    }
    await client.query(
      `UPDATE projection_versions SET status='RETIRED'
        WHERE projection_name=$1 AND version=$2`,
      [PROJECTION_NAME, expectedActive],
    );
    await client.query(
      `UPDATE projection_versions SET status='ACTIVE', activated_at=clock_timestamp()
        WHERE projection_name=$1 AND version=$2 AND status='BUILDING'`,
      [PROJECTION_NAME, building],
    );
  }

  /** Удаляет не опубликованную BUILDING версию после failed rebuild. */
  async deleteBuilding(client: PoolClient, version: number): Promise<void> {
    await client.query(
      `DELETE FROM projection_versions
        WHERE projection_name=$1 AND version=$2 AND status='BUILDING'`,
      [PROJECTION_NAME, version],
    );
  }

  /** Читает schema/version lag активной projection без пользовательских IDs. */
  async metrics(client: PoolClient): Promise<ProjectionMetrics> {
    const result = await client.query<{
      schema_version: number;
      applied_sequence: string;
      source_sequence: string;
    }>(
      `SELECT schema_version, applied_sequence, source_sequence
         FROM projection_versions WHERE projection_name=$1 AND status='ACTIVE'`,
      [PROJECTION_NAME],
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
  }
}
