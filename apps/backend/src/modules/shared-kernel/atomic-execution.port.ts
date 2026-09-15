/**
 * Порт атомарного выполнения application use case.
 *
 * Domain/application orchestration использует этот интерфейс вместо PostgreSQL
 * client. Component adapter просто вызывает callback; durable adapter открывает
 * ACID transaction, которую вложенные repositories получают через context.
 */
export interface AtomicExecutionPort {
  /** Выполняет callback целиком либо откатывает все его persistence effects. */
  execute<T>(operation: () => Promise<T>): Promise<T>;
}

/**
 * DI-токен общей transaction boundary.
 *
 * Component runtime связывает его с прямым вызовом callback, а production-like
 * runtime — с PostgreSQL transaction. Application service поэтому не импортирует
 * `PoolClient` и не меняет алгоритм при переключении topology.
 */
export const ATOMIC_EXECUTION_PORT = Symbol('ATOMIC_EXECUTION_PORT');

/**
 * Component implementation без внешней transaction.
 * In-memory aggregates уже изменяются синхронно и используются одним процессом.
 */
export const DIRECT_ATOMIC_EXECUTION: AtomicExecutionPort = {
  execute: <T>(operation: () => Promise<T>): Promise<T> => operation(),
};
