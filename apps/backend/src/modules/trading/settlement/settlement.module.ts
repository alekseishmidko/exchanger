import { Module } from '@nestjs/common';
import { EventLogModule, EVENT_LOG_PORT } from '../event-log';
import type { EventLogPort } from '../event-log';
import { LedgerModule, LEDGER_PORT } from '../../ledger';
import type { LedgerPort } from '../../ledger';
import { ATOMIC_EXECUTION_PORT } from '../../shared-kernel/atomic-execution.port';
import type { AtomicExecutionPort } from '../../shared-kernel/atomic-execution.port';
import { SettlementService } from './settlement';

/**
 * Composition root settlement application boundary.
 *
 * Модуль связывает orchestration только с публичными ports. В component profile
 * callback выполняется напрямую над in-memory adapters; в production-like
 * profile глобальный `ATOMIC_EXECUTION_PORT` открывает PostgreSQL transaction,
 * которую автоматически переиспользуют ledger и outbox adapters.
 *
 * @example Consumer получает `SettlementService` через DI и вызывает
 * `consumeTrades(3)`; offset будет зафиксирован только после ledger commit.
 */
@Module({
  imports: [LedgerModule, EventLogModule],
  providers: [
    {
      provide: SettlementService,
      inject: [LEDGER_PORT, EVENT_LOG_PORT, ATOMIC_EXECUTION_PORT],
      useFactory: (
        ledger: LedgerPort,
        eventLog: EventLogPort,
        atomic: AtomicExecutionPort,
      ): SettlementService =>
        new SettlementService(ledger, eventLog, 8, undefined, undefined, undefined, atomic),
    },
  ],
  exports: [SettlementService],
})
export class SettlementModule {}
