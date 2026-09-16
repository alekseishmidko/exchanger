/** Стабильный token durable ownership и recovery boundary. */
export const SEQUENCER_STORE_PORT = Symbol('SEQUENCER_STORE_PORT');

/**
 * Lease instrument partition с fencing epoch, проверяемым при каждой записи.
 *
 * `leaseUntil` используется только для operational diagnostics: решение о
 * валидности принимает adapter на стороне durable store. `recoveryRequired`
 * запрещает caller сразу резервировать sequence после takeover.
 *
 * @example
 * `{ instrumentId: 'BTC-USD', ownerId: 'backend-2', fencingEpoch: 8,
 * leaseUntil: '2026-09-17T10:00:15.000Z', recoveryRequired: true }`.
 */
export type PartitionLease = Readonly<{
  instrumentId: string;
  ownerId: string;
  fencingEpoch: number;
  leaseUntil: string;
  recoveryRequired: boolean;
}>;

/**
 * Проверенный snapshot, привязанный к sequence и event-log boundary.
 *
 * Payload является сериализованным состоянием state machine, но не source of
 * truth. После его загрузки всегда replay-ятся commands до `highWatermark`.
 */
export type DurableSnapshot<T = unknown> = Readonly<{
  version: number;
  instrumentId: string;
  lastSequence: number;
  boundaryEventOffset: number;
  fencingEpoch: number;
  payload: T;
  checksum: string;
}>;

/** Команда, которую новый owner обязан replay-нуть перед открытием admission. */
export type RecoveryCommand = Readonly<{
  commandId: string;
  sequence: number;
  payload: unknown;
  publicResult: unknown;
}>;

/** План restart recovery от последнего snapshot до durable high watermark. */
export type RecoveryPlan = Readonly<{
  snapshot: DurableSnapshot | null;
  commands: readonly RecoveryCommand[];
  highWatermark: number;
}>;

/**
 * Порт durable sequencing без зависимости application-кода от PostgreSQL.
 *
 * Любая mutation требует актуальный fencing epoch. Старый процесс после lease
 * transfer получает `STALE_FENCING_TOKEN`, даже если ещё не заметил потерю
 * ownership. Admission открывается только после успешного recovery.
 */
export interface SequencerStorePort {
  /**
   * Захватывает свободный/истёкший lease либо продлевает lease того же owner.
   *
   * Takeover увеличивает epoch и возвращает `recoveryRequired=true`; активный
   * lease другого owner отклоняется. TTL обязан быть больше максимальной
   * ожидаемой command transaction и регулярно продлеваться orchestration layer.
   *
   * @throws Error `PARTITION_ALREADY_OWNED`, если чужой lease ещё действует.
   */
  acquire(instrumentId: string, ownerId: string, ttlMs: number): Promise<PartitionLease>;
  /**
   * Продлевает lease только при совпадении owner, epoch и непросроченного TTL.
   * Старый token после takeover получает `STALE_FENCING_TOKEN` и не может
   * воскресить прежнее ownership.
   */
  renew(lease: PartitionLease, ttlMs: number): Promise<PartitionLease>;
  /**
   * Атомарно резервирует следующую sequence внутри command transaction.
   * Rollback внешней transaction обязан откатить и sequence, чтобы повтор не
   * создавал gap. Метод разрешён только для `READY` partition с открытым admission.
   */
  reserveSequence(lease: PartitionLease): Promise<number>;
  /**
   * Строит ordered recovery plan и проверяет checksum/version snapshot.
   * Возвращаемые commands идут без gap от snapshot sequence до durable high
   * watermark; любое несовпадение блокирует восстановление.
   */
  prepareRecovery(lease: PartitionLease, supportedSnapshotVersion: number): Promise<RecoveryPlan>;
  /**
   * Открывает admission после применения всего recovery plan.
   * `recoveredSequence` должен в точности совпасть с durable high watermark;
   * передача меньшего или большего значения не допускает частичный restore.
   */
  completeRecovery(lease: PartitionLease, recoveredSequence: number): Promise<void>;
  /**
   * Создаёт snapshot только при отсутствии in-flight accepted commands.
   * Adapter привязывает payload к текущим sequence, event offset и fencing epoch
   * и вычисляет checksum по каноническому представлению данных.
   */
  saveSnapshot<T>(lease: PartitionLease, version: number, payload: T): Promise<DurableSnapshot<T>>;
  /**
   * Закрывает admission и освобождает lease только после drain in-flight work.
   * Если work ещё выполняется, lease сохраняется до expiry, а caller получает
   * ошибку и не должен объявлять graceful shutdown успешным.
   */
  gracefulShutdown(lease: PartitionLease): Promise<void>;
  /**
   * Проверяет доступность lease store безопасным read-only запросом.
   * Probe не захватывает ownership и не изменяет sequence, поэтому его можно
   * вызывать из readiness с bounded timeout.
   */
  checkReady(): Promise<void>;
}
