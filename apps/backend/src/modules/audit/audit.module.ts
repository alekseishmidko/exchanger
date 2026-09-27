import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { POSTGRES_TRANSACTION, PostgresTransactionManager } from '../../infrastructure/postgres';
import { AuditLog } from './domain/audit-log';
import { PostgresAuditLog } from './infrastructure/postgres-audit-log';
import { AUDIT_LOG_PORT, AuditLogPort } from './ports/audit.port';

/** Composition root append-only audit boundary. */
@Module({
  providers: [
    /** In-memory реализация нужна component tests и служит domain implementation. */
    AuditLog,
    /** Выбирает append-only PostgreSQL log для durable runtime. */
    {
      provide: AUDIT_LOG_PORT,
      inject: [ConfigService, POSTGRES_TRANSACTION],
      useFactory: (
        config: ConfigService,
        transactions: PostgresTransactionManager,
      ): AuditLogPort =>
        config.getOrThrow('AUDIT_STORE_ADAPTER') === 'postgres'
          ? new PostgresAuditLog(transactions)
          : new AuditLog(),
    },
  ],
  /** Экспортирует domain implementation и абстрактный port для совместимости consumers. */
  exports: [AuditLog, AUDIT_LOG_PORT],
})
export class AuditModule {}
