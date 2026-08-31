import { Decimal } from '../../shared-kernel';
import { Instrument } from './instrument';

/** Минимальная форма заявки, необходимая для проверки trading rules. */
export type OrderForValidation = Readonly<{
  orderType: 'LIMIT' | 'MARKET';
  quantity: Decimal;
  limitPrice?: Decimal;
  openOrders: number;
}>;

/** Результат успешной проверки заявки и зафиксированной версии правил. */
export type ValidatedOrder = Readonly<{
  valid: true;
  rulesVersion: string;
  feePolicyVersion: string;
}>;

/** Ошибка нарушения конкретного торгового ограничения. */
export class TradingRuleViolation extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'TradingRuleViolation';
  }
}

/** Проверяет заявку относительно immutable rules snapshot инструмента. */
export function validateOrder(
  instrument: Instrument,
  order: OrderForValidation,
  at: Date = new Date(),
): ValidatedOrder {
  if (instrument.getStatus() !== 'ACTIVE') {
    throw new TradingRuleViolation('INSTRUMENT_PAUSED');
  }
  const rules = instrument.getRulesAt(at);
  if (
    order.quantity.isNegative() ||
    order.quantity.isZero() ||
    !order.quantity.isMultipleOf(rules.lotSize) ||
    order.quantity.compare(rules.minQuantity) < 0 ||
    order.quantity.compare(rules.maxQuantity) > 0 ||
    order.quantity.compare(rules.limits.maxOrderQuantity) > 0
  ) {
    throw new TradingRuleViolation('INVALID_QUANTITY');
  }
  if (order.openOrders < 0 || order.openOrders >= rules.limits.maxOpenOrders) {
    throw new TradingRuleViolation('OPEN_ORDER_LIMIT');
  }
  if (order.orderType === 'LIMIT') {
    if (!order.limitPrice) throw new TradingRuleViolation('LIMIT_PRICE_REQUIRED');
    if (
      !order.limitPrice.isMultipleOf(rules.tickSize) ||
      order.limitPrice.compare(rules.priceBand.min) < 0 ||
      order.limitPrice.compare(rules.priceBand.max) > 0
    ) {
      throw new TradingRuleViolation('INVALID_PRICE');
    }
    if (order.quantity.multiply(order.limitPrice).compare(rules.limits.maxNotional) > 0) {
      throw new TradingRuleViolation('NOTIONAL_LIMIT');
    }
  } else if (order.limitPrice) {
    throw new TradingRuleViolation('MARKET_PRICE_NOT_ALLOWED');
  }
  return {
    valid: true,
    rulesVersion: rules.version,
    feePolicyVersion: rules.feePolicyVersion,
  };
}
