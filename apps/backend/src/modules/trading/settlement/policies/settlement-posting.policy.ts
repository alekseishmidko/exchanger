import type { AccountId, Decimal } from '../../../shared-kernel';
import type { TradeExecuted } from '../settlement';

/** Раскладка участников и комиссий сделки для построения posting matrix. */
export type SettlementPostingPlan = Readonly<{
  buyerAccountId: AccountId;
  sellerAccountId: AccountId;
  buyerFee: Decimal;
  sellerFee: Decimal;
  value: Decimal;
}>;

/**
 * Policy построения posting matrix settlement.
 *
 * Класс ничего не пишет в ledger и не знает про event log. Он только вычисляет,
 * кто является buyer/seller, какая quote value должна перейти продавцу и какая
 * fee удерживается с каждой стороны. Это делает финансовую формулу отдельно
 * проверяемой от infrastructure orchestration.
 */
export class SettlementPostingPolicy {
  /** Возвращает детерминированный план проводок для `TradeExecuted`. */
  buildPlan(event: TradeExecuted): SettlementPostingPlan {
    const makerIsBuyer = event.makerSide === 'BUY';
    return {
      buyerAccountId: makerIsBuyer ? event.makerAccountId : event.takerAccountId,
      sellerAccountId: makerIsBuyer ? event.takerAccountId : event.makerAccountId,
      buyerFee: makerIsBuyer ? event.makerFee : event.takerFee,
      sellerFee: makerIsBuyer ? event.takerFee : event.makerFee,
      value: event.quantity.multiply(event.price),
    };
  }
}
