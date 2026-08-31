import { AssetId, Decimal, createId } from '../../shared-kernel';

/** Lifecycle-состояние торгового инструмента. */
export type InstrumentStatus = 'ACTIVE' | 'PAUSED';

/** Ограничения количества, цены и операционной нагрузки инструмента. */
export type TradingLimits = Readonly<{
  maxOrderQuantity: Decimal;
  maxOpenOrders: number;
  maxNotional: Decimal;
}>;

/** Диапазон разрешённых цен инструмента. */
export type PriceBand = Readonly<{
  min: Decimal;
  max: Decimal;
}>;

/** Неизменяемая версия правил, применяемая по effectiveAt. */
export type InstrumentRules = Readonly<{
  version: string;
  effectiveAt: Date;
  tickSize: Decimal;
  lotSize: Decimal;
  minQuantity: Decimal;
  maxQuantity: Decimal;
  priceBand: PriceBand;
  feePolicyVersion: string;
  limits: TradingLimits;
}>;

/** Торговая пара с base/quote assets и версионированными правилами. */
export class Instrument {
  private status: InstrumentStatus = 'PAUSED';
  private readonly rules: InstrumentRules[];

  constructor(
    readonly id: string,
    readonly baseAssetId: AssetId,
    readonly quoteAssetId: AssetId,
    initialRules: InstrumentRules,
  ) {
    if (id.trim() === '' || baseAssetId === quoteAssetId) {
      throw new Error('Invalid instrument identity');
    }
    this.assertRules(initialRules);
    this.rules = [initialRules];
  }

  /** Возвращает текущий lifecycle status инструмента. */
  getStatus(): InstrumentStatus {
    return this.status;
  }

  /** Переводит инструмент в ACTIVE только после проверки его правил. */
  activate(): void {
    const latest = this.rules[this.rules.length - 1];
    if (!latest) throw new Error('Instrument rules are missing');
    this.assertRules(latest);
    this.status = 'ACTIVE';
  }

  /** Приостанавливает новые заявки, сохраняя историю правил. */
  pause(): void {
    this.status = 'PAUSED';
  }

  /** Добавляет будущую версию правил без изменения уже сохранённых версий. */
  addRules(rules: InstrumentRules): void {
    this.assertRules(rules);
    const latest = this.rules[this.rules.length - 1];
    if (latest && rules.effectiveAt <= latest.effectiveAt) {
      throw new Error('Rules effectiveAt must be monotonic');
    }
    this.rules.push(rules);
  }

  /** Возвращает правила, действующие на указанный момент времени. */
  getRulesAt(at: Date = new Date()): InstrumentRules {
    const applicable = this.rules.filter((rules) => rules.effectiveAt <= at);
    const result = applicable[applicable.length - 1];
    if (!result) throw new Error('No effective instrument rules');
    return result;
  }

  /** Возвращает все версии правил для аудита без возможности изменения массива. */
  getRulesHistory(): readonly InstrumentRules[] {
    return [...this.rules];
  }

  private assertRules(rules: InstrumentRules): void {
    const positive = [
      rules.tickSize,
      rules.lotSize,
      rules.minQuantity,
      rules.maxQuantity,
      rules.priceBand.min,
      rules.priceBand.max,
      rules.limits.maxOrderQuantity,
      rules.limits.maxNotional,
    ];
    if (
      positive.some((value) => value.isNegative() || value.isZero()) ||
      rules.priceBand.min.compare(rules.priceBand.max) > 0 ||
      rules.minQuantity.compare(rules.maxQuantity) > 0 ||
      rules.maxQuantity.compare(rules.limits.maxOrderQuantity) > 0 ||
      !Number.isInteger(rules.limits.maxOpenOrders) ||
      rules.limits.maxOpenOrders < 1 ||
      rules.version.trim() === '' ||
      rules.feePolicyVersion.trim() === ''
    ) {
      throw new Error('Invalid instrument rules');
    }
  }
}

/** Создаёт typed instrument ID для внешних каталогов и audit records. */
export function instrumentId(value: string): string {
  return createId<'InstrumentId'>(value);
}
