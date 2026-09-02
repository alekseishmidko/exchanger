/** Политика времени, позволяющая тестировать state machine без системных часов. */
export interface DeterministicClock {
  /** Возвращает заранее контролируемый момент времени. */
  now(): Date;
}

/** Минимальная команда, допускаемая trading state machine. */
export type StateMachineCommand<TPayload> = Readonly<{
  commandId: string;
  instrumentId: string;
  sequence: number;
  payload: TPayload;
}>;

/** Снимок state machine для restart/replay. */
export type StateMachineSnapshot<TResult = unknown> = Readonly<{
  instrumentId: string;
  sequence: number;
  status: 'ACTIVE' | 'PAUSED';
  processedCommands: readonly Readonly<{ commandId: string; result: TResult }>[];
  capturedAt: string;
}>;

/** Ошибка admission с машинно-обрабатываемым кодом. */
export class StateMachineAdmissionError extends Error {
  constructor(readonly code: 'PAUSED' | 'SEQUENCE_GAP' | 'INVALID_SEQUENCE' | 'DUPLICATE_COMMAND') {
    super(code);
    this.name = 'StateMachineAdmissionError';
  }
}

/** Deterministic state machine одного instrument partition. */
export class TradingStateMachine<TPayload, TResult> {
  private sequence = 0;
  private status: 'ACTIVE' | 'PAUSED' = 'ACTIVE';
  private readonly processed = new Map<string, TResult>();

  constructor(
    readonly instrumentId: string,
    private readonly transition: (payload: TPayload) => TResult,
    private readonly clock: DeterministicClock,
  ) {}

  /** Принимает строго следующую команду или возвращает прежний duplicate result. */
  apply(command: StateMachineCommand<TPayload>): TResult {
    const previous = this.processed.get(command.commandId);
    if (previous !== undefined) return previous;
    if (this.status === 'PAUSED') throw new StateMachineAdmissionError('PAUSED');
    if (command.instrumentId !== this.instrumentId || command.sequence < 1) {
      throw new StateMachineAdmissionError('INVALID_SEQUENCE');
    }
    if (command.sequence !== this.sequence + 1) {
      throw new StateMachineAdmissionError('SEQUENCE_GAP');
    }
    const result = this.transition(command.payload);
    this.sequence = command.sequence;
    this.processed.set(command.commandId, result);
    return result;
  }

  /** Приостанавливает admission новых команд для инструмента. */
  pause(): void {
    this.status = 'PAUSED';
  }

  /** Возобновляет admission после внешней проверки правил. */
  resume(): void {
    this.status = 'ACTIVE';
  }

  /** Возвращает sequence и lifecycle status partition. */
  getState(): Readonly<{ sequence: number; status: 'ACTIVE' | 'PAUSED' }> {
    return { sequence: this.sequence, status: this.status };
  }

  /** Создаёт сериализуемую snapshot boundary для crash/restart восстановления. */
  createSnapshot(): StateMachineSnapshot<TResult> {
    return {
      instrumentId: this.instrumentId,
      sequence: this.sequence,
      status: this.status,
      processedCommands: [...this.processed.entries()].map(([commandId, result]) => ({
        commandId,
        result,
      })),
      capturedAt: this.clock.now().toISOString(),
    };
  }

  /** Восстанавливает admission metadata из проверенного snapshot. */
  restoreSnapshot(snapshot: StateMachineSnapshot<TResult>): void {
    if (snapshot.instrumentId !== this.instrumentId || snapshot.sequence < 0) {
      throw new Error('Invalid state machine snapshot');
    }
    if (snapshot.sequence < this.sequence) {
      throw new Error('Snapshot sequence is older than current state');
    }
    this.sequence = snapshot.sequence;
    this.status = snapshot.status;
    this.processed.clear();
    for (const { commandId, result } of snapshot.processedCommands) {
      this.processed.set(commandId, result);
    }
  }
}
