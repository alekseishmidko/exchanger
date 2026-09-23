/**
 * Контракты managed durable workers.
 *
 * Worker — это не бизнес-сервис и не HTTP transport. Это управляемая
 * runtime-обёртка вокруг consumer-а: она задаёт batch/concurrency/timeout,
 * retry/backoff/jitter, lag metric, graceful shutdown и quarantine boundary.
 * Конкретный consumer внутри может читать command journal, outbox, settlement
 * queue, projection stream или market-data fan-out.
 */

/** Имена критичных background consumers trading runtime. */
export type DurableWorkerName = 'command' | 'outbox' | 'settlement' | 'projection' | 'market-data';

/** Machine-readable состояние worker-а для readiness, runbook и dashboard. */
export type DurableWorkerState =
  'STOPPED' | 'RECOVERING' | 'RUNNING' | 'DRAINING' | 'UNHEALTHY' | 'QUARANTINED';

/** Bounded execution policy одного worker loop. */
export type DurableWorkerPolicy = Readonly<{
  /** Максимум элементов, которые worker берёт за один tick. */
  batchSize: number;
  /** Максимум одновременных tick-ов одного worker-а. */
  concurrency: number;
  /** Deadline одного batch. После timeout batch считается failed и уходит в retry policy. */
  timeoutMs: number;
  /** Максимум попыток перед quarantine/DLQ. */
  maxAttempts: number;
  /** Начальная задержка retry. */
  baseBackoffMs: number;
  /** Верхняя граница retry delay. */
  maxBackoffMs: number;
  /** Интервал idle polling. */
  pollIntervalMs: number;
}>;

/** Результат одного committed worker batch. */
export type DurableWorkerBatchResult = Readonly<{
  /** Сколько элементов получили business commit. */
  processed: number;
  /** Сколько элементов ушли в retry/DLQ/quarantine. */
  quarantined?: number;
  /** Текущий backlog/lag после batch. */
  lag: number;
}>;

/** Snapshot состояния worker-а без payload, секретов и пользовательских IDs. */
export type DurableWorkerStatus = Readonly<{
  name: DurableWorkerName;
  state: DurableWorkerState;
  lag: number;
  inFlight: number;
  lastErrorCode: string | null;
  lastCommittedAt: string | null;
}>;

/** Контекст одного batch-вызова, который worker получает от managed runner. */
export type DurableWorkerExecution = Readonly<{
  policy: DurableWorkerPolicy;
  signal: AbortSignal;
}>;

/**
 * Port конкретного durable consumer-а.
 *
 * `processBatch` обязан фиксировать offset только после business commit. Если
 * crash происходит до commit, следующий запуск должен увидеть прежний offset и
 * безопасно переобработать тот же элемент через идемпотентность/DLQ.
 */
export interface DurableWorker {
  readonly name: DurableWorkerName;
  /** Восстанавливает lease/snapshot/replay до high watermark перед admission. */
  recover?(): Promise<void>;
  /** Возвращает readiness worker-а без destructive queries. */
  checkReady?(): Promise<void>;
  /** Обрабатывает bounded batch и возвращает новый lag. */
  processBatch(execution: DurableWorkerExecution): Promise<DurableWorkerBatchResult>;
  /** Безопасно повторяет quarantined событие без изменения исходной записи. */
  replayQuarantined?(eventId: string, operatorId: string): Promise<string>;
}

/** DI token массива durable workers. */
export const DURABLE_WORKERS = Symbol('DURABLE_WORKERS');

/** DI token managed lifecycle/readiness service. */
export const DURABLE_WORKER_MANAGER = Symbol('DURABLE_WORKER_MANAGER');
