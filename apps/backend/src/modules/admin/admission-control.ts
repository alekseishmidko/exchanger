/** Публичный API admission-control sub-boundary без импорта полного AdminModule. */
export * from './infrastructure/admission-control.module';
export * from './infrastructure/memory-admission-control';
export * from './infrastructure/postgres-admission-control';
export * from './ports/admission-control.port';
