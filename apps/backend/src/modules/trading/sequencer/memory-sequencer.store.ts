import type {
  DurableSnapshot,
  PartitionLease,
  RecoveryPlan,
  SequencerStorePort,
} from './sequencer.port';

/** Component-only deterministic implementation durable sequencer port. */
export class MemorySequencerStore implements SequencerStorePort {
  private readonly leases = new Map<string, PartitionLease>();
  private readonly sequences = new Map<string, number>();
  private readonly snapshots = new Map<string, DurableSnapshot>();

  /** Захватывает partition в однопроцессном component runtime. */
  acquire(instrumentId: string, ownerId: string, ttlMs: number): Promise<PartitionLease> {
    const current = this.leases.get(instrumentId);
    if (current && current.ownerId !== ownerId) throw new Error('PARTITION_ALREADY_OWNED');
    const lease = {
      instrumentId,
      ownerId,
      fencingEpoch: current?.fencingEpoch ?? 1,
      leaseUntil: new Date(Date.now() + ttlMs).toISOString(),
      recoveryRequired: false,
    };
    this.leases.set(instrumentId, lease);
    return Promise.resolve(lease);
  }

  /** Продлевает component lease после проверки token. */
  renew(lease: PartitionLease, ttlMs: number): Promise<PartitionLease> {
    this.assertLease(lease);
    return this.acquire(lease.instrumentId, lease.ownerId, ttlMs);
  }

  /** Возвращает следующую process-local sequence. */
  reserveSequence(lease: PartitionLease): Promise<number> {
    this.assertLease(lease);
    const sequence = (this.sequences.get(lease.instrumentId) ?? 0) + 1;
    this.sequences.set(lease.instrumentId, sequence);
    return Promise.resolve(sequence);
  }

  /** Возвращает snapshot и пустой replay plan для component tests. */
  prepareRecovery(lease: PartitionLease): Promise<RecoveryPlan> {
    this.assertLease(lease);
    return Promise.resolve({
      snapshot: this.snapshots.get(lease.instrumentId) ?? null,
      commands: [],
      highWatermark: this.sequences.get(lease.instrumentId) ?? 0,
    });
  }

  /** Фиксирует восстановленную sequence перед admission. */
  completeRecovery(lease: PartitionLease, recoveredSequence: number): Promise<void> {
    this.assertLease(lease);
    this.sequences.set(lease.instrumentId, recoveredSequence);
    return Promise.resolve();
  }

  /** Сохраняет component snapshot для parity с production port. */
  saveSnapshot<T>(lease: PartitionLease, version: number, payload: T): Promise<DurableSnapshot<T>> {
    this.assertLease(lease);
    const snapshot = {
      version,
      instrumentId: lease.instrumentId,
      lastSequence: this.sequences.get(lease.instrumentId) ?? 0,
      boundaryEventOffset: 0,
      fencingEpoch: lease.fencingEpoch,
      payload,
      checksum: 'component-checksum',
    };
    this.snapshots.set(lease.instrumentId, snapshot);
    return Promise.resolve(snapshot);
  }

  /** Освобождает component lease после закрытия admission. */
  gracefulShutdown(lease: PartitionLease): Promise<void> {
    this.assertLease(lease);
    this.leases.delete(lease.instrumentId);
    return Promise.resolve();
  }

  /** Memory dependency всегда готова в component runtime. */
  checkReady(): Promise<void> {
    return Promise.resolve();
  }

  /** Отклоняет mutation от старого или чужого owner. */
  private assertLease(lease: PartitionLease): void {
    const current = this.leases.get(lease.instrumentId);
    if (
      !current ||
      current.ownerId !== lease.ownerId ||
      current.fencingEpoch !== lease.fencingEpoch
    ) {
      throw new Error('STALE_FENCING_TOKEN');
    }
  }
}
