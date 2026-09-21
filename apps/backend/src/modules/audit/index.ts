/** Публичный API audit-модуля без deep imports. */
export * from './domain/audit-log';
export * from './ports/audit.port';
export * from './infrastructure/postgres-audit-log';
export * from './audit.module';
