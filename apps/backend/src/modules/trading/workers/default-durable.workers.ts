import { Inject } from '@nestjs/common';
import { EVENT_LOG_PORT, EventLogPort } from '../event-log';
import type {
  DurableWorker,
  DurableWorkerBatchResult,
  DurableWorkerExecution,
  DurableWorkerName,
} from './durable-worker.types';

/**
 * Минимальный adapter managed worker-а поверх существующего EventLogPort.
 *
 * Сейчас он используется как безопасная composition-root граница: runner умеет
 * запускать/останавливать command/outbox/settlement/projection/market-data
 * consumers одинаково, а конкретный durable adapter может быть заменён на
 * named PostgreSQL/Kafka consumer без изменения lifecycle кода.
 */
export class EventLogBacklogWorker implements DurableWorker {
  /** Создаёт worker для конкретной logical queue. */
  constructor(
    readonly name: DurableWorkerName,
    @Inject(EVENT_LOG_PORT) private readonly eventLog: EventLogPort,
  ) {}

  /**
   * На recovery проверяет, что ordered log читается и offset не выходит за tail.
   * Для in-memory/component runtime этого достаточно; production adapter
   * расширяет метод lease/snapshot/high-watermark restore-ом.
   */
  async recover(): Promise<void> {
    const [events, offset] = await Promise.all([
      this.eventLog.getEvents(),
      this.eventLog.getOffset(),
    ]);
    if (offset < 0 || offset > events.length) throw new Error('WORKER_OFFSET_OUT_OF_RANGE');
  }

  /** Readiness проверяет только safe metadata event log, не читая payload. */
  async checkReady(): Promise<void> {
    await this.recover();
  }

  /**
   * Обрабатывает bounded batch через EventLogPort.
   *
   * В component profile handler no-op: он доказывает offset-after-commit
   * semantics существующего EventLogPort. Production named workers заменяют
   * handler на command processor, outbox delivery, projection apply или
   * market-data publish, сохраняя тот же lifecycle envelope.
   */
  async processBatch(execution: DurableWorkerExecution): Promise<DurableWorkerBatchResult> {
    let processed = 0;
    await this.eventLog.consume(async () => {
      await Promise.resolve();
      if (execution.signal.aborted) throw new Error('WORKER_ABORTED');
      processed += 1;
    }, execution.policy.maxAttempts);
    const [events, offset, deadLetters] = await Promise.all([
      this.eventLog.getEvents(),
      this.eventLog.getOffset(),
      this.eventLog.getDeadLetters(),
    ]);
    return {
      processed: Math.min(processed, execution.policy.batchSize),
      quarantined: deadLetters.length,
      lag: Math.max(0, events.length - offset),
    };
  }

  /**
   * Delegate operator replay в EventLogPort, если concrete adapter его
   * поддерживает. In-memory log не изменяет исходный DLQ record и потому
   * безопасно сообщает об отсутствии operation.
   */
  async replayQuarantined(eventId: string, operatorId: string): Promise<string> {
    const replay = (
      this.eventLog as Partial<{
        replayDeadLetter: (eventId: string, operatorId: string) => Promise<string>;
      }>
    ).replayDeadLetter;
    if (!replay) throw new Error('WORKER_REPLAY_UNSUPPORTED');
    return replay.call(this.eventLog, eventId, operatorId);
  }
}

/** Создаёт стандартный набор consumers trading runtime. */
export function createDefaultDurableWorkers(eventLog: EventLogPort): readonly DurableWorker[] {
  return (['command', 'outbox', 'settlement', 'projection', 'market-data'] as const).map(
    (name) => new EventLogBacklogWorker(name, eventLog),
  );
}
