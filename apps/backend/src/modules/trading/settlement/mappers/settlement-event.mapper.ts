import { Decimal } from '../../../shared-kernel';
import type { SettlementApplied, TradeExecuted, TradeExecutedPayload } from '../settlement';

/**
 * Mapper durable event-log payloads settlement модуля.
 *
 * Event log хранит JSON, поэтому decimal value objects нельзя писать как
 * JavaScript numbers или bigint-структуры. Mapper сохраняет decimals строками и
 * восстанавливает их через `Decimal.from`, чтобы poison payload ушёл в retry/DLQ,
 * а не попал в ledger posting с потерей точности.
 */
export class SettlementEventMapper {
  /** Преобразует domain trade event в JSON-safe payload без floating point. */
  serializeTrade(event: TradeExecuted): TradeExecutedPayload {
    return {
      ...event,
      quantity: event.quantity.toString(),
      price: event.price.toString(),
      makerFee: event.makerFee.toString(),
      takerFee: event.takerFee.toString(),
    };
  }

  /** Восстанавливает точные Decimal value objects из durable JSON payload. */
  deserializeTrade(payload: unknown): TradeExecuted {
    const event = payload as TradeExecutedPayload;
    return {
      ...event,
      quantity: Decimal.from(event.quantity),
      price: Decimal.from(event.price),
      makerFee: Decimal.from(event.makerFee),
      takerFee: Decimal.from(event.takerFee),
    };
  }

  /** Создаёт публичное событие SettlementApplied после успешных ledger postings. */
  toSettlementApplied(event: TradeExecuted, postingIds: readonly string[]): SettlementApplied {
    return {
      eventId: `settlement-event-${event.tradeId}`,
      ...(event.correlationId ? { correlationId: event.correlationId } : {}),
      causationId: event.eventId,
      settlementId: `settlement-${event.tradeId}`,
      tradeId: event.tradeId,
      postingIds,
    };
  }
}
