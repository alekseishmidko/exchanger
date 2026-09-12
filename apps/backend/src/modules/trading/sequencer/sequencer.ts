import {
  StateMachineAdmissionError,
  StateMachineCommand,
  TradingStateMachine,
} from '../state-machine';
import {
  LOG_EVENTS,
  NOOP_OPERATIONAL_LOGGER,
  NOOP_TELEMETRY,
  NOOP_OPERATIONAL_METRICS,
  OperationalMetrics,
  OperationalLogger,
  TelemetryPort,
  TRACE_SPANS,
} from '../../observability';

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

  /**
   * Создаёт sequencer, лениво выделяющий отдельную state machine на инструмент.
   *
   * InstrumentId не экспортируется как metric label: span содержит только
   * bounded тип partition. Gap фиксируется счётчиком, но исходная admission
   * ошибка остаётся результатом state machine и не маскируется observability.
   *
   * @param createMachine Фабрика изолированного состояния instrument partition.
   * @param logger Operational events принятия и отказа команды.
   * @param telemetry Port для измерения sequencer wait/application boundary.
   * @param metrics Метрики sequence gap с bounded component label.
   */
  constructor(
    private readonly createMachine: (
      instrumentId: string,
    ) => TradingStateMachine<TPayload, TResult>,
    private readonly logger: OperationalLogger = NOOP_OPERATIONAL_LOGGER,
    private readonly telemetry: TelemetryPort = NOOP_TELEMETRY,
    private readonly metrics: OperationalMetrics = NOOP_OPERATIONAL_METRICS,
  ) {}

  /** Назначает единственного owner для instrument partition. */
  assignOwner(instrumentId: string, ownerId: string): void {
    if (ownerId.trim() === '') throw new PartitionOwnershipError('OWNER_REQUIRED');
    const current = this.owners.get(instrumentId);
    if (current && current !== ownerId) throw new PartitionOwnershipError('NOT_OWNER');
    this.owners.set(instrumentId, ownerId);
  }

  /**
   * Передаёт команду только назначенному owner и нужной state machine.
   *
   * @param command Команда с instrument, owner и ожидаемой последовательностью.
   * @returns Ранее сохранённый результат duplicate либо результат нового apply.
   * @throws PartitionOwnershipError Если partition не назначена этому owner.
   * @throws StateMachineAdmissionError Если sequence содержит gap или нарушает policy.
   */
  submit(command: SequencedCommand<TPayload>): TResult {
    return this.telemetry.span(TRACE_SPANS.SEQUENCER_WAIT, { 'partition.kind': 'instrument' }, () =>
      this.submitObserved(command),
    );
  }

  /** Проверяет ownership и применяет команду внутри sequencer tracing boundary. */
  private submitObserved(command: SequencedCommand<TPayload>): TResult {
    try {
      const owner = this.owners.get(command.instrumentId);
      if (!owner) throw new PartitionOwnershipError('PARTITION_UNASSIGNED');
      if (owner !== command.ownerId) throw new PartitionOwnershipError('NOT_OWNER');
      const machine =
        this.machines.get(command.instrumentId) ?? this.createMachine(command.instrumentId);
      this.machines.set(command.instrumentId, machine);
      const result = machine.apply(command);
      this.logger.info('sequencer', LOG_EVENTS.SEQUENCER_COMMAND_APPLIED, {
        commandId: command.commandId,
        metadata: { instrumentId: command.instrumentId, sequence: command.sequence },
      });
      return result;
    } catch (error) {
      if (error instanceof StateMachineAdmissionError && String(error.code).includes('GAP')) {
        this.metrics.observeGap('sequencer');
      }
      this.logger.warn('sequencer', LOG_EVENTS.SEQUENCER_COMMAND_REJECTED, {
        commandId: command.commandId,
        metadata: {
          instrumentId: command.instrumentId,
          sequence: command.sequence,
          rejectionCode:
            error instanceof StateMachineAdmissionError || error instanceof PartitionOwnershipError
              ? error.code
              : 'INTERNAL_REJECTION',
        },
      });
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
