import type {
  BalanceView,
  OrderView,
  ProjectionEvent,
  ProjectionMetrics,
  ProjectionPage,
  TradeView,
} from './projection';

/**
 * Стабильный DI-токен versioned projection repository boundary.
 *
 * Query controller зависит от token, поэтому не получает прямой доступ к
 * таблицам read model и не может обойти owner filtering или cursor policy.
 */
export const PROJECTION_STORE_PORT = Symbol('PROJECTION_STORE_PORT');

/**
 * Порт read-model и consumer transaction boundary.
 *
 * Durable adapter обязан применять event, записывать processed eventId и
 * продвигать offset в одной транзакции. Query-методы всегда фильтруют данные по
 * owner и возвращают bounded page, поэтому controller не получает доступ к
 * таблицам или внутреннему состоянию consumer.
 */
export interface ProjectionStorePort {
  /**
   * Идемпотентно применяет следующее последовательное событие.
   * Duplicate eventId не меняет модель, а sequence gap останавливает consumer.
   */
  apply(event: ProjectionEvent): void;
  /**
   * Перестраивает версию read-model из упорядоченного журнала.
   * @param events Полный ordered stream выбранной rebuild boundary.
   */
  rebuild(events: readonly ProjectionEvent[]): void;
  /**
   * Возвращает принадлежащую пользователю историю заявок.
   * @param userId Identity из authentication context, а не query string.
   * @param limit Ограниченный размер страницы.
   * @param cursor Opaque позиция следующей страницы.
   */
  getOrders(userId: string, limit?: number, cursor?: string): ProjectionPage<OrderView>;
  /** Возвращает bounded историю сделок только указанного владельца. */
  getTrades(userId: string, limit?: number, cursor?: string): ProjectionPage<TradeView>;
  /** Возвращает bounded projected balances только указанного владельца. */
  getBalances(userId: string, limit?: number, cursor?: string): ProjectionPage<BalanceView>;
  /**
   * Возвращает bounded lag/schema metrics текущей версии projection.
   * Метрики не содержат userId/eventId и не создают unbounded cardinality.
   */
  getMetrics(): ProjectionMetrics;
}
