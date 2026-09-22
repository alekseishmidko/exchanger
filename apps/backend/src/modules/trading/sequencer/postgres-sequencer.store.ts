import { Inject } from '@nestjs/common';
import type { QueryResultRow } from 'pg';
import { POSTGRES_TRANSACTION, PostgresTransactionManager } from '../../../infrastructure/postgres';
import { canonicalJson, sha256 } from '../../../infrastructure/postgres/postgres-json';
import type {
  DurableSnapshot,
  PartitionLease,
  RecoveryCommand,
  RecoveryPlan,
  SequencerStorePort,
} from './sequencer.port';

type LeaseRow = QueryResultRow & {
  instrument_id: string;
  owner_id: string;
  fencing_epoch: string;
  lease_until: Date;
};

type PartitionRow = QueryResultRow & {
  fencing_epoch: string;
};

/**
 * PostgreSQL lease/fencing, sequence, snapshot и recovery adapter.
 *
 * Lease row блокируется в каждой mutation. Transfer увеличивает epoch и
 * закрывает admission; прежний token после этого физически не может обновить
 * sequence или snapshot. Snapshot checksum вычисляется по каноническому JSON.
 */
export class PostgresSequencerStore implements SequencerStorePort {
  /** Создаёт adapter, участвующий в общей command transaction. */
  constructor(
    @Inject(POSTGRES_TRANSACTION) private readonly transactions: PostgresTransactionManager,
  ) {}

  /**
   * Захватывает новый/истёкший lease или продлевает lease текущего owner.
   * Transfer увеличивает fencing epoch и переводит partition в `RECOVERING`.
   */
  acquire(instrumentId: string, ownerId: string, ttlMs: number): Promise<PartitionLease> {
    return this.transactions.run(async (client) => {
      const current = await client.query<LeaseRow>(
        'SELECT * FROM partition_leases WHERE instrument_id=$1 FOR UPDATE',
        [instrumentId],
      );
      const row = current.rows[0];
      const partition = await client.query<PartitionRow>(
        'SELECT fencing_epoch FROM sequencer_partitions WHERE instrument_id=$1 FOR UPDATE',
        [instrumentId],
      );
      const partitionRow = partition.rows[0];
      const now = Date.now();
      const leaseIsActive = Boolean(row && row.lease_until.getTime() > now);
      if (row && row.owner_id !== ownerId && leaseIsActive) {
        throw new Error('PARTITION_ALREADY_OWNED');
      }
      const canRenew = Boolean(row && row.owner_id === ownerId && leaseIsActive);
      const recoveryRequired = Boolean(partitionRow && !canRenew);
      const previousEpoch = Math.max(
        Number(row?.fencing_epoch ?? 0),
        Number(partitionRow?.fencing_epoch ?? 0),
      );
      const epoch = canRenew ? previousEpoch : previousEpoch + 1;
      const leaseUntil = new Date(now + ttlMs);
      await client.query(
        `INSERT INTO partition_leases
          (instrument_id, owner_id, fencing_epoch, lease_until)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (instrument_id) DO UPDATE
         SET owner_id=EXCLUDED.owner_id, fencing_epoch=EXCLUDED.fencing_epoch,
             lease_until=EXCLUDED.lease_until, updated_at=clock_timestamp()`,
        [instrumentId, ownerId, epoch, leaseUntil],
      );
      await client.query(
        `INSERT INTO sequencer_partitions
          (instrument_id, fencing_epoch, recovery_status, admission_open)
         VALUES ($1, $2, 'READY', TRUE)
         ON CONFLICT (instrument_id) DO UPDATE
         SET fencing_epoch=$2,
             recovery_status=CASE WHEN $3 THEN 'RECOVERING' ELSE sequencer_partitions.recovery_status END,
             admission_open=CASE WHEN $3 THEN FALSE ELSE sequencer_partitions.admission_open END,
             updated_at=clock_timestamp()`,
        [instrumentId, epoch, recoveryRequired],
      );
      return this.mapLease(instrumentId, ownerId, epoch, leaseUntil, recoveryRequired);
    });
  }

  /** Продлевает lease без изменения epoch; stale token отклоняется. */
  renew(lease: PartitionLease, ttlMs: number): Promise<PartitionLease> {
    return this.transactions.run(async (client) => {
      const leaseUntil = new Date(Date.now() + ttlMs);
      const updated = await client.query<LeaseRow>(
        `UPDATE partition_leases SET lease_until=$4, updated_at=clock_timestamp()
          WHERE instrument_id=$1 AND owner_id=$2 AND fencing_epoch=$3
            AND lease_until > clock_timestamp()
          RETURNING *`,
        [lease.instrumentId, lease.ownerId, lease.fencingEpoch, leaseUntil],
      );
      if (!updated.rows[0]) throw new Error('STALE_FENCING_TOKEN');
      return this.mapLease(
        lease.instrumentId,
        lease.ownerId,
        lease.fencingEpoch,
        leaseUntil,
        false,
      );
    });
  }

  /** Резервирует sequence только READY partition с актуальным fencing token. */
  reserveSequence(lease: PartitionLease): Promise<number> {
    return this.transactions.run(async (client) => {
      await this.lockValidLease(client, lease);
      const result = await client.query<{ last_sequence: string }>(
        `UPDATE sequencer_partitions
            SET last_sequence=last_sequence+1,
                durable_high_watermark=last_sequence+1,
                updated_at=clock_timestamp()
          WHERE instrument_id=$1 AND fencing_epoch=$2
            AND recovery_status='READY' AND admission_open=TRUE
          RETURNING last_sequence`,
        [lease.instrumentId, lease.fencingEpoch],
      );
      if (!result.rows[0]) throw new Error('PARTITION_NOT_READY');
      return Number(result.rows[0].last_sequence);
    });
  }

  /** Загружает и проверяет snapshot, затем формирует contiguous command replay. */
  prepareRecovery(lease: PartitionLease, supportedSnapshotVersion: number): Promise<RecoveryPlan> {
    return this.transactions.run(async (client) => {
      await this.lockValidLease(client, lease);
      const snapshots = await client.query<{
        snapshot_version: number;
        last_sequence: string;
        boundary_event_offset: string;
        fencing_epoch: string;
        payload: unknown;
        checksum: string;
      }>(
        `SELECT snapshot_version, last_sequence, boundary_event_offset,
                fencing_epoch, payload, checksum
           FROM trading_snapshots WHERE instrument_id=$1
           ORDER BY last_sequence DESC LIMIT 1`,
        [lease.instrumentId],
      );
      const snapshotRow = snapshots.rows[0];
      let snapshot: DurableSnapshot | null = null;
      let startSequence = 0;
      if (snapshotRow) {
        if (snapshotRow.snapshot_version !== supportedSnapshotVersion) {
          throw new Error('SNAPSHOT_VERSION_UNSUPPORTED');
        }
        const expected = this.snapshotChecksum(
          snapshotRow.snapshot_version,
          lease.instrumentId,
          Number(snapshotRow.last_sequence),
          Number(snapshotRow.boundary_event_offset),
          snapshotRow.payload,
        );
        if (expected !== snapshotRow.checksum) throw new Error('SNAPSHOT_CHECKSUM_INVALID');
        startSequence = Number(snapshotRow.last_sequence);
        snapshot = {
          version: snapshotRow.snapshot_version,
          instrumentId: lease.instrumentId,
          lastSequence: startSequence,
          boundaryEventOffset: Number(snapshotRow.boundary_event_offset),
          fencingEpoch: Number(snapshotRow.fencing_epoch),
          payload: snapshotRow.payload,
          checksum: snapshotRow.checksum,
        };
      }
      const rows = await client.query<{
        command_id: string;
        sequence: string;
        command_payload: unknown;
        public_result: unknown;
      }>(
        `SELECT command_id, sequence, command_payload, public_result
           FROM command_journal
          WHERE instrument_id=$1 AND sequence>$2 AND status='APPLIED'
          ORDER BY sequence`,
        [lease.instrumentId, startSequence],
      );
      const commands: RecoveryCommand[] = rows.rows.map((row) => ({
        commandId: row.command_id,
        sequence: Number(row.sequence),
        payload: row.command_payload,
        publicResult: row.public_result,
      }));
      for (let index = 0; index < commands.length; index += 1) {
        if (commands[index]?.sequence !== startSequence + index + 1) {
          throw new Error('RECOVERY_SEQUENCE_GAP');
        }
      }
      const state = await client.query<{ durable_high_watermark: string }>(
        `SELECT durable_high_watermark FROM sequencer_partitions
          WHERE instrument_id=$1 FOR UPDATE`,
        [lease.instrumentId],
      );
      const highWatermark = Number(state.rows[0]?.durable_high_watermark ?? startSequence);
      const replayedThrough = commands.at(-1)?.sequence ?? startSequence;
      if (replayedThrough !== highWatermark) throw new Error('RECOVERY_SEQUENCE_GAP');
      return {
        snapshot,
        commands,
        highWatermark,
      };
    });
  }

  /** Открывает admission только если replay достиг durable high watermark. */
  completeRecovery(lease: PartitionLease, recoveredSequence: number): Promise<void> {
    return this.transactions.run(async (client) => {
      await this.lockValidLease(client, lease);
      const updated = await client.query(
        `UPDATE sequencer_partitions
            SET recovery_status='READY', admission_open=TRUE,
                last_sequence=$3, updated_at=clock_timestamp()
          WHERE instrument_id=$1 AND fencing_epoch=$2
            AND durable_high_watermark=$3`,
        [lease.instrumentId, lease.fencingEpoch, recoveredSequence],
      );
      if (updated.rowCount !== 1) throw new Error('RECOVERY_HIGH_WATERMARK_MISMATCH');
    });
  }

  /** Сохраняет snapshot после проверки отсутствия in-flight commands. */
  saveSnapshot<T>(lease: PartitionLease, version: number, payload: T): Promise<DurableSnapshot<T>> {
    return this.transactions.run(async (client) => {
      await this.lockValidLease(client, lease);
      const state = await client.query<{ last_sequence: string }>(
        `SELECT last_sequence FROM sequencer_partitions
          WHERE instrument_id=$1 AND fencing_epoch=$2 FOR UPDATE`,
        [lease.instrumentId, lease.fencingEpoch],
      );
      const lastSequence = Number(state.rows[0]?.last_sequence ?? -1);
      if (lastSequence < 0) throw new Error('PARTITION_NOT_FOUND');
      const inFlight = await client.query(
        `SELECT 1 FROM command_journal
          WHERE instrument_id=$1 AND status IN ('RECEIVED', 'ACCEPTED', 'PROCESSING', 'RECOVERY_REQUIRED') LIMIT 1`,
        [lease.instrumentId],
      );
      if (inFlight.rowCount) throw new Error('SNAPSHOT_IN_FLIGHT_COMMANDS');
      const boundary = await client.query<{ event_offset: string }>(
        'SELECT COALESCE(MAX(event_offset), 0) AS event_offset FROM outbox_events',
      );
      const boundaryEventOffset = Number(boundary.rows[0]?.event_offset ?? 0);
      const checksum = this.snapshotChecksum(
        version,
        lease.instrumentId,
        lastSequence,
        boundaryEventOffset,
        payload,
      );
      await client.query(
        `INSERT INTO trading_snapshots
          (instrument_id, snapshot_version, last_sequence, boundary_event_offset,
           fencing_epoch, payload, checksum)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
         ON CONFLICT (instrument_id, last_sequence) DO NOTHING`,
        [
          lease.instrumentId,
          version,
          lastSequence,
          boundaryEventOffset,
          lease.fencingEpoch,
          canonicalJson(payload),
          checksum,
        ],
      );
      return {
        version,
        instrumentId: lease.instrumentId,
        lastSequence,
        boundaryEventOffset,
        fencingEpoch: lease.fencingEpoch,
        payload,
        checksum,
      };
    });
  }

  /** Закрывает admission, убеждается в drain и удаляет только свой lease. */
  gracefulShutdown(lease: PartitionLease): Promise<void> {
    return this.transactions.run(async (client) => {
      await this.lockValidLease(client, lease);
      await client.query(
        `UPDATE sequencer_partitions SET admission_open=FALSE,
          recovery_status='DRAINING', updated_at=clock_timestamp()
          WHERE instrument_id=$1 AND fencing_epoch=$2`,
        [lease.instrumentId, lease.fencingEpoch],
      );
      const inFlight = await client.query(
        `SELECT 1 FROM command_journal
          WHERE instrument_id=$1 AND status IN ('RECEIVED', 'ACCEPTED', 'PROCESSING', 'RECOVERY_REQUIRED') LIMIT 1`,
        [lease.instrumentId],
      );
      if (inFlight.rowCount) throw new Error('GRACEFUL_SHUTDOWN_IN_FLIGHT');
      await client.query(
        'DELETE FROM partition_leases WHERE instrument_id=$1 AND owner_id=$2 AND fencing_epoch=$3',
        [lease.instrumentId, lease.ownerId, lease.fencingEpoch],
      );
    });
  }

  /** Выполняет bounded read-only probe таблиц ownership store. */
  checkReady(): Promise<void> {
    return this.transactions.run(
      async (client) => {
        await client.query('SELECT 1 FROM partition_leases LIMIT 1');
      },
      { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    );
  }

  /** Блокирует lease row и проверяет owner, epoch и срок действия. */
  private async lockValidLease(
    client: ReturnType<PostgresTransactionManager['currentClient']>,
    lease: PartitionLease,
  ): Promise<void> {
    const result = await client.query(
      `SELECT 1 FROM partition_leases
        WHERE instrument_id=$1 AND owner_id=$2 AND fencing_epoch=$3
          AND lease_until > clock_timestamp() FOR UPDATE`,
      [lease.instrumentId, lease.ownerId, lease.fencingEpoch],
    );
    if (!result.rowCount) throw new Error('STALE_FENCING_TOKEN');
  }

  /** Формирует стабильный snapshot checksum без timestamp/owner полей. */
  private snapshotChecksum(
    version: number,
    instrumentId: string,
    lastSequence: number,
    boundaryEventOffset: number,
    payload: unknown,
  ): string {
    return sha256({ version, instrumentId, lastSequence, boundaryEventOffset, payload });
  }

  /** Преобразует SQL lease в публичный immutable contract. */
  private mapLease(
    instrumentId: string,
    ownerId: string,
    fencingEpoch: number,
    leaseUntil: Date,
    recoveryRequired: boolean,
  ): PartitionLease {
    return {
      instrumentId,
      ownerId,
      fencingEpoch,
      leaseUntil: leaseUntil.toISOString(),
      recoveryRequired,
    };
  }
}
