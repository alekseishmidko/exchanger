import { Decimal } from '../shared-kernel';

/** Состояние available/reserved с проверкой неотрицательности. */
export class Balance {
  private constructor(
    readonly available: Decimal,
    readonly reserved: Decimal,
  ) {}

  /** Создаёт пустой баланс. */
  static empty(): Balance {
    return new Balance(Decimal.from('0'), Decimal.from('0'));
  }

  /** Зачисляет положительную сумму в available. */
  credit(amount: Decimal): Balance {
    Balance.requirePositive(amount);
    return new Balance(this.available.add(amount), this.reserved);
  }

  /** Списывает сумму только из available при достаточном остатке. */
  debit(amount: Decimal): Balance {
    Balance.requirePositive(amount);
    const available = this.available.subtract(amount);
    Balance.requireNonNegative(available, 'Insufficient available balance');
    return new Balance(available, this.reserved);
  }

  /** Переводит сумму из available в reserved. */
  reserve(amount: Decimal): Balance {
    Balance.requirePositive(amount);
    return this.debit(amount).withReserved(this.reserved.add(amount));
  }

  /** Возвращает зарезервированную сумму в available. */
  release(amount: Decimal): Balance {
    Balance.requirePositive(amount);
    const reserved = this.reserved.subtract(amount);
    Balance.requireNonNegative(reserved, 'Insufficient reserved balance');
    return new Balance(this.available.add(amount), reserved);
  }

  /** Списывает сумму из reserved при завершении операции. */
  debitReserved(amount: Decimal): Balance {
    Balance.requirePositive(amount);
    const reserved = this.reserved.subtract(amount);
    Balance.requireNonNegative(reserved, 'Insufficient reserved balance');
    return new Balance(this.available, reserved);
  }

  private withReserved(reserved: Decimal): Balance {
    return new Balance(this.available, reserved);
  }

  private static requirePositive(amount: Decimal): void {
    if (amount.isNegative() || amount.isZero()) {
      throw new Error('Amount must be positive');
    }
  }

  private static requireNonNegative(amount: Decimal, message: string): void {
    if (amount.isNegative()) {
      throw new Error(message);
    }
  }
}
