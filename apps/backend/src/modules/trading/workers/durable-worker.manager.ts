import {
  Inject,
  Injectable,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  MetricsService,
  NOOP_OPERATIONAL_LOGGER,
  NOOP_OPERATIONAL_METRICS,
  OperationalLogger,
  OperationalMetrics,
  StructuredLogger,
  LOG_EVENTS,
} from '../../observability';
import {
  DURABLE_WORKERS,
  DurableWorker,
  DurableWorkerName,
  DurableWorkerPolicy,
  DurableWorkerState,
  DurableWorkerStatus,
} from './durable-worker.types';

/** Default bounded policy, если env не переопределяет значения. */
const DEFAULT_POLICY: DurableWorkerPolicy = {
  batchSize: 50,
  concurrency: 1,
  timeoutMs: 5_000,
  maxAttempts: 3,
  baseBackoffMs: 25,
  maxBackoffMs: 1_000,
  pollIntervalMs: 1_000,
};

type MutableWorkerStatus = {
  name: DurableWorkerName;
  state: DurableWorkerState;
  lag: number;
  inFlight: number;
  lastErrorCode: string | null;
  lastCommittedAt: string | null;
};

/**
 * Управляет lifecycle durable background workers.
 *
 * Composition root вызывает `onApplicationBootstrap`, после чего manager:
 *
 * 1. выполняет recovery каждого worker-а до открытия безопасной обработки;
 * 2. запускает bounded polling loop;
 * 3. фиксирует lag metrics;
 * 4. при shutdown переводит workers в `DRAINING` и ждёт in-flight batch.
 *
 * Manager не знает про HTTP controllers и не выполняет business logic сам —
 * он только обеспечивает одинаковую эксплуатационную оболочку для command,
 * outbox, settlement, projection и market-data consumers.
 */
@Injectable()
export class DurableWorkerManager implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly policy: DurableWorkerPolicy;
  private readonly logger: OperationalLogger;
  private readonly metrics: OperationalMetrics;
  private readonly timers = new Map<DurableWorkerName, NodeJS.Timeout>();
  private readonly inFlight = new Map<DurableWorkerName, Set<Promise<void>>>();
  private readonly statuses = new Map<DurableWorkerName, MutableWorkerStatus>();
  private stopping = false;

  /** Создаёт manager из DI-bound workers и безопасных env defaults. */
  constructor(
    @Inject(DURABLE_WORKERS) private readonly workers: readonly DurableWorker[],
    @Optional() private readonly config?: ConfigService,
    @Optional() @Inject(StructuredLogger) logger?: StructuredLogger,
    @Optional() metrics?: MetricsService,
  ) {
    this.logger = logger ?? NOOP_OPERATIONAL_LOGGER;
    this.metrics = metrics ?? NOOP_OPERATIONAL_METRICS;
    this.policy = this.readPolicy();
    for (const worker of workers) {
      this.statuses.set(worker.name, {
        name: worker.name,
        state: 'STOPPED',
        lag: 0,
        inFlight: 0,
        lastErrorCode: null,
        lastCommittedAt: null,
      });
      this.inFlight.set(worker.name, new Set());
    }
  }

  /** Запускает workers при старте приложения, если профиль не отключил loop. */
  async onApplicationBootstrap(): Promise<void> {
    if (!this.enabled()) return;
    await this.recoverAll();
    this.start();
  }

  /** Graceful shutdown: admission снаружи закрывается, workers drain-ятся. */
  async onApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  /** Выполняет recovery всех workers и оставляет их в RUNNING-ready state. */
  async recoverAll(): Promise<void> {
    for (const worker of this.workers) {
      const status = this.requireStatus(worker.name);
      status.state = 'RECOVERING';
      try {
        await worker.recover?.();
        status.state = 'RUNNING';
        status.lastErrorCode = null;
      } catch (error) {
        status.state = 'UNHEALTHY';
        status.lastErrorCode = this.errorCode(error);
        throw error;
      }
    }
  }

  /** Запускает polling loop для каждого worker-а. */
  start(): void {
    if (this.stopping) return;
    for (const worker of this.workers) {
      if (this.timers.has(worker.name)) continue;
      this.schedule(worker, 0);
    }
  }

  /** Останавливает polling и ждёт in-flight batches без потери offset commit. */
  async stop(): Promise<void> {
    this.stopping = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const status of this.statuses.values()) {
      if (status.state === 'RUNNING' || status.state === 'RECOVERING') status.state = 'DRAINING';
    }
    await Promise.all([...this.inFlight.values()].flatMap((set) => [...set]));
    for (const status of this.statuses.values()) {
      status.inFlight = 0;
      if (status.state === 'DRAINING') status.state = 'STOPPED';
    }
  }

  /**
   * Выполняет один batch выбранного worker-а.
   *
   * Метод публичен для deterministic tests и runbook-driven one-shot recovery.
   * Production loop вызывает его через scheduler и не допускает concurrency выше
   * policy limit.
   */
  async tick(workerName: DurableWorkerName): Promise<void> {
    const worker = this.workers.find((candidate) => candidate.name === workerName);
    if (!worker) throw new Error(`UNKNOWN_WORKER:${workerName}`);
    const status = this.requireStatus(workerName);
    if (status.inFlight >= this.policy.concurrency) return;

    const task = this.executeWithRetry(worker);
    this.track(workerName, task);
    await task;
  }

  /** Readiness hook: critical workers должны быть RUNNING и отвечать checkReady. */
  async checkReady(): Promise<void> {
    if (!this.enabled()) return;
    for (const worker of this.workers) {
      const status = this.requireStatus(worker.name);
      if (!['RUNNING', 'DRAINING'].includes(status.state)) {
        throw new Error(`WORKER_NOT_READY:${worker.name}`);
      }
      await worker.checkReady?.();
    }
  }

  /** Возвращает безопасный snapshot для diagnostics endpoint/runbook/tests. */
  getStatuses(): readonly DurableWorkerStatus[] {
    return [...this.statuses.values()].map((status) => ({ ...status }));
  }

  /** Делегирует replay quarantined event конкретному worker-у. */
  async replayQuarantined(
    workerName: DurableWorkerName,
    eventId: string,
    operatorId: string,
  ): Promise<string> {
    const worker = this.workers.find((candidate) => candidate.name === workerName);
    if (!worker?.replayQuarantined) throw new Error('WORKER_REPLAY_UNSUPPORTED');
    return worker.replayQuarantined(eventId, operatorId);
  }

  /** Выполняет retry/backoff/jitter вокруг одного batch. */
  private async executeWithRetry(worker: DurableWorker): Promise<void> {
    const status = this.requireStatus(worker.name);
    status.state = status.state === 'STOPPED' ? 'RUNNING' : status.state;
    for (let attempt = 1; attempt <= this.policy.maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.policy.timeoutMs);
      try {
        const result = await worker.processBatch({
          policy: this.policy,
          signal: controller.signal,
        });
        clearTimeout(timeout);
        status.lag = result.lag;
        status.lastCommittedAt = new Date().toISOString();
        status.lastErrorCode = null;
        status.state = result.quarantined ? 'QUARANTINED' : 'RUNNING';
        this.metrics.setLag('consumer', worker.name, result.lag);
        this.logger.info('workers', LOG_EVENTS.WORKER_BATCH_APPLIED, {
          metadata: {
            worker: worker.name,
            processed: result.processed,
            quarantined: result.quarantined ?? 0,
            lag: result.lag,
          },
        });
        return;
      } catch (error) {
        clearTimeout(timeout);
        status.lastErrorCode = this.errorCode(error);
        if (attempt === this.policy.maxAttempts) {
          status.state = 'UNHEALTHY';
          this.logger.failure('workers', LOG_EVENTS.WORKER_BATCH_FAILED, {
            metadata: { worker: worker.name, attempt },
          });
          throw error;
        }
        await this.delay(this.backoff(attempt));
      }
    }
  }

  /** Планирует следующий polling tick с idle interval. */
  private schedule(worker: DurableWorker, delayMs: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(worker.name);
      if (this.stopping) return;
      void this.tick(worker.name).finally(() => {
        if (!this.stopping) this.schedule(worker, this.policy.pollIntervalMs);
      });
    }, delayMs);
    timer.unref?.();
    this.timers.set(worker.name, timer);
  }

  /** Учитывает in-flight Promise для drain на shutdown. */
  private track(workerName: DurableWorkerName, task: Promise<void>): void {
    const set = this.inFlight.get(workerName);
    if (!set) return;
    const status = this.requireStatus(workerName);
    set.add(task);
    status.inFlight = set.size;
    task.then(
      () => {
        set.delete(task);
        status.inFlight = set.size;
      },
      () => {
        set.delete(task);
        status.inFlight = set.size;
      },
    );
  }

  /** Читает worker policy через ConfigService.get с безопасными fallback. */
  private readPolicy(): DurableWorkerPolicy {
    const numberValue = (key: string, fallback: number): number => {
      const value = this.config?.get<string | number>(key, fallback);
      const normalized = Number(value);
      return Number.isFinite(normalized) && normalized > 0 ? normalized : fallback;
    };
    return {
      batchSize: numberValue('WORKER_BATCH_SIZE', DEFAULT_POLICY.batchSize),
      concurrency: numberValue('WORKER_CONCURRENCY', DEFAULT_POLICY.concurrency),
      timeoutMs: numberValue('WORKER_TIMEOUT_MS', DEFAULT_POLICY.timeoutMs),
      maxAttempts: numberValue('WORKER_MAX_ATTEMPTS', DEFAULT_POLICY.maxAttempts),
      baseBackoffMs: numberValue('WORKER_BASE_BACKOFF_MS', DEFAULT_POLICY.baseBackoffMs),
      maxBackoffMs: numberValue('WORKER_MAX_BACKOFF_MS', DEFAULT_POLICY.maxBackoffMs),
      pollIntervalMs: numberValue('WORKER_POLL_INTERVAL_MS', DEFAULT_POLICY.pollIntervalMs),
    };
  }

  /** WORKERS_ENABLED=false оставляет приложение без background loop для component tests. */
  private enabled(): boolean {
    const value = this.config?.get<string>('WORKERS_ENABLED', 'true') ?? 'true';
    return !['false', '0'].includes(value);
  }

  /** Bounded exponential backoff с jitter, чтобы не создать retry storm. */
  private backoff(attempt: number): number {
    const exponential = Math.min(
      this.policy.maxBackoffMs,
      this.policy.baseBackoffMs * 2 ** (attempt - 1),
    );
    const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(exponential / 4)));
    return Math.min(this.policy.maxBackoffMs, exponential + jitter);
  }

  /** Не блокирует event loop между retry attempts. */
  private delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  /** Возвращает status или бросает programming error при неполной registry. */
  private requireStatus(name: DurableWorkerName): MutableWorkerStatus {
    const status = this.statuses.get(name);
    if (!status) throw new Error(`WORKER_STATUS_MISSING:${name}`);
    return status;
  }

  /** Безопасный error code без message/stack/payload. */
  private errorCode(error: unknown): string {
    return error instanceof Error ? error.name : 'UNKNOWN_ERROR';
  }
}
