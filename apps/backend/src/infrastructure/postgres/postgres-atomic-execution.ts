import { Inject } from '@nestjs/common';
import type { AtomicExecutionPort } from '../../modules/shared-kernel/atomic-execution.port';
import { POSTGRES_TRANSACTION } from './postgres.tokens';
import { PostgresTransactionManager } from './postgres-transaction';

/**
 * PostgreSQL реализация application-level atomic execution.
 *
 * Используется orchestration services, которым нужно объединить несколько ports:
 * например, settlement фиксирует все ledger postings и `SettlementApplied`
 * outbox event без dual-write окна.
 */
export class PostgresAtomicExecution implements AtomicExecutionPort {
  /**
   * Создаёт boundary поверх общего transaction manager.
   * @param transactions Менеджер, передающий один `PoolClient` всем вложенным adapters.
   */
  constructor(
    @Inject(POSTGRES_TRANSACTION) private readonly transactions: PostgresTransactionManager,
  ) {}

  /**
   * Открывает или переиспользует transaction вокруг полного use case.
   * @example `atomic.execute(() => settlement.apply(trade))` commit-ит ledger и outbox вместе.
   */
  execute<T>(operation: () => Promise<T>): Promise<T> {
    return this.transactions.run(operation);
  }
}
