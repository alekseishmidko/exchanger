import {
  StateMachineAdmissionError,
  StateMachineCommand,
  TradingStateMachine,
} from '../state-machine';

/** Команда с ownership context конкретной partition. */
export type SequencedCommand<TPayload> = StateMachineCommand<TPayload> &
  Readonly<{
    ownerId: string;
  }>;

/** Ошибка partition routing/ownership. */
export class PartitionOwnershipError extends Error {
  constructor(readonly code: 'OWNER_REQUIRED' | 'NOT_OWNER' | 'PARTITION_UNASSIGNED') {
    super(code);
    this.name = 'PartitionOwnershipError';
  }
}

/** Последовательный sequencer, разделяющий state machine по instrumentId. */
export class TradingSequencer<TPayload, TResult> {
  private readonly owners = new Map<string, string>();
  private readonly machines = new Map<string, TradingStateMachine<TPayload, TResult>>();

  constructor(
    private readonly createMachine: (
      instrumentId: string,
    ) => TradingStateMachine<TPayload, TResult>,
  ) {}

  /** Назначает единственного owner для instrument partition. */
  assignOwner(instrumentId: string, ownerId: string): void {
    if (ownerId.trim() === '') throw new PartitionOwnershipError('OWNER_REQUIRED');
    const current = this.owners.get(instrumentId);
    if (current && current !== ownerId) throw new PartitionOwnershipError('NOT_OWNER');
    this.owners.set(instrumentId, ownerId);
  }

  /** Передаёт команду только назначенному owner и нужной state machine. */
  submit(command: SequencedCommand<TPayload>): TResult {
    const owner = this.owners.get(command.instrumentId);
    if (!owner) throw new PartitionOwnershipError('PARTITION_UNASSIGNED');
    if (owner !== command.ownerId) throw new PartitionOwnershipError('NOT_OWNER');
    const machine =
      this.machines.get(command.instrumentId) ?? this.createMachine(command.instrumentId);
    this.machines.set(command.instrumentId, machine);
    try {
      return machine.apply(command);
    } catch (error) {
      if (error instanceof StateMachineAdmissionError) throw error;
      throw error;
    }
  }

  /** Приостанавливает только одну instrument partition. */
  pause(instrumentId: string, ownerId: string): void {
    this.requireOwner(instrumentId, ownerId);
    this.machine(instrumentId).pause();
  }

  /** Возобновляет только одну instrument partition. */
  resume(instrumentId: string, ownerId: string): void {
    this.requireOwner(instrumentId, ownerId);
    this.machine(instrumentId).resume();
  }

  /** Возвращает sequence/status конкретного instrument partition. */
  getState(instrumentId: string): Readonly<{ sequence: number; status: 'ACTIVE' | 'PAUSED' }> {
    return this.machine(instrumentId).getState();
  }

  private machine(instrumentId: string): TradingStateMachine<TPayload, TResult> {
    const machine = this.machines.get(instrumentId) ?? this.createMachine(instrumentId);
    this.machines.set(instrumentId, machine);
    return machine;
  }

  private requireOwner(instrumentId: string, ownerId: string): void {
    if (this.owners.get(instrumentId) !== ownerId) {
      throw new PartitionOwnershipError('NOT_OWNER');
    }
  }
}
