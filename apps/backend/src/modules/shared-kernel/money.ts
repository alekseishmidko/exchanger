import { AssetId } from './ids';
import { Decimal } from './decimal';

/** Точная денежная сумма, связанная с конкретным активом. */
export class Money {
  constructor(
    readonly assetId: AssetId,
    readonly amount: Decimal,
  ) {}

  /** Складывает суммы только одного актива. */
  add(other: Money): Money {
    this.requireSameAsset(other);
    return new Money(this.assetId, this.amount.add(other.amount));
  }

  /** Вычитает суммы только одного актива. */
  subtract(other: Money): Money {
    this.requireSameAsset(other);
    return new Money(this.assetId, this.amount.subtract(other.amount));
  }

  /** Округляет сумму до точности актива. */
  round(scale: number): Money {
    return new Money(this.assetId, this.amount.round(scale));
  }

  private requireSameAsset(other: Money): void {
    if (this.assetId !== other.assetId) {
      throw new Error('Money asset mismatch');
    }
  }
}
