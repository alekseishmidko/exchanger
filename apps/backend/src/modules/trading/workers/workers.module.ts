import { Module } from '@nestjs/common';
import { EventLogModule, EVENT_LOG_PORT, EventLogPort } from '../event-log';
import { DURABLE_WORKER_MANAGER, DURABLE_WORKERS } from './durable-worker.types';
import { DurableWorkerManager } from './durable-worker.manager';
import { createDefaultDurableWorkers } from './default-durable.workers';

/**
 * Composition root managed durable workers.
 *
 * Модуль регистрирует command, outbox, settlement, projection и market-data
 * consumers как управляемый набор. Он не импортирует GatewayModule и поэтому не
 * создаёт цикл `Gateway ↔ MarketData`; HTTP admission остаётся снаружи, а
 * workers получают только durable ports.
 */
@Module({
  imports: [
    /** Даёт workers единый ordered event source и consumer offsets. */
    EventLogModule,
  ],
  providers: [
    /** Создаёт стандартный набор bounded durable consumers поверх event-log port. */
    {
      provide: DURABLE_WORKERS,
      inject: [EVENT_LOG_PORT],
      useFactory: (eventLog: EventLogPort) => createDefaultDurableWorkers(eventLog),
    },
    /** Управляет startup, polling, readiness и graceful shutdown всех workers. */
    DurableWorkerManager,
    /** Публикует manager под стабильным token для health и orchestration consumers. */
    { provide: DURABLE_WORKER_MANAGER, useExisting: DurableWorkerManager },
  ],
  /** Health/runtime получают workers и manager без знания factory details. */
  exports: [DURABLE_WORKERS, DURABLE_WORKER_MANAGER, DurableWorkerManager],
})
export class TradingWorkersModule {}
