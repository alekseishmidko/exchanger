import type { TraceCarrier } from '../../observability';

/** Событие event log, достаточное для построения read-моделей. */
export type ProjectionEvent = Readonly<{
  eventId: string;
  correlationId?: string;
  causationId?: string;
  trace?: TraceCarrier;
  eventType:
    'OrderAccepted' | 'OrderRejected' | 'OrderCancelled' | 'TradeExecuted' | 'SettlementApplied';
  sequence: number;
  payload: Record<string, unknown>;
}>;

/** Запись истории заявки, доступная query API только её владельцу. */
export type OrderView = Readonly<{
  orderId: string;
  userId: string;
  accountId: string;
  instrumentId: string;
  status: 'ACCEPTED' | 'REJECTED' | 'CANCELLED';
  remainingQuantity: string;
  updatedAtSequence: number;
}>;

/** Запись сделки для maker и taker history queries. */
export type TradeView = Readonly<{
  tradeId: string;
  instrumentId: string;
  userIds: readonly string[];
  makerOrderId: string;
  takerOrderId: string;
  quantity: string;
  price: string;
  sequence: number;
}>;

/** Изменение баланса, накопленное из SettlementApplied posting deltas. */
export type BalanceView = Readonly<{
  accountId: string;
  assetId: string;
  available: string;
  reserved: string;
  sequence: number;
}>;

/** Страница query API с opaque cursor для стабильной постраничной выдачи. */
export type ProjectionPage<T> = Readonly<{ items: readonly T[]; nextCursor: string | null }>;

/** Метрики актуальности projection consumer. */
export type ProjectionMetrics = Readonly<{
  schemaVersion: number;
  appliedSequence: number;
  sourceSequence: number;
  lag: number;
}>;
