const DECIMAL_PATTERN = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?$/;

/** Произвольное точное десятичное число на основе bigint без floating point. */
export class Decimal {
  private constructor(
    private readonly coefficient: bigint,
    private readonly scale: number,
  ) {}

  /** Разбирает каноническую десятичную строку и отклоняет двусмысленные форматы. */
  static from(value: string): Decimal {
    const match = DECIMAL_PATTERN.exec(value);
    if (!match) {
      throw new Error('Invalid decimal value');
    }
    const [, sign, integer, fraction = ''] = match;
    const digits = `${integer}${fraction}`;
    const coefficient = BigInt(`${sign === '-' ? '-' : ''}${digits}`);
    return Decimal.normalize(new Decimal(coefficient, fraction.length));
  }

  /** Создаёт неотрицательное десятичное число из безопасного integer. */
  static fromInteger(value: number): Decimal {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error('Integer must be a non-negative safe integer');
    }
    return new Decimal(BigInt(value), 0);
  }

  /** Складывает два значения без потери точности. */
  add(other: Decimal): Decimal {
    const [left, right, scale] = Decimal.align(this, other);
    return Decimal.normalize(new Decimal(left + right, scale));
  }

  /** Вычитает второе значение без потери точности. */
  subtract(other: Decimal): Decimal {
    return this.add(other.negate());
  }

  /** Умножает два точных десятичных значения без перехода к number. */
  multiply(other: Decimal): Decimal {
    return Decimal.normalize(
      new Decimal(this.coefficient * other.coefficient, this.scale + other.scale),
    );
  }

  /** Меняет знак числа. */
  negate(): Decimal {
    return new Decimal(-this.coefficient, this.scale);
  }

  /** Сравнивает числа: -1, 0 или 1. */
  compare(other: Decimal): -1 | 0 | 1 {
    const [left, right] = Decimal.align(this, other);
    return left < right ? -1 : left > right ? 1 : 0;
  }

  /** Проверяет, делится ли значение без остатка на заданный шаг. */
  isMultipleOf(step: Decimal): boolean {
    if (step.isNegative() || step.isZero() || this.isNegative()) {
      return false;
    }
    const [value, divisor, scale] = Decimal.align(this, step);
    return value % divisor === 0n && scale >= 0;
  }

  /** Возвращает true для отрицательного значения. */
  isNegative(): boolean {
    return this.coefficient < 0n;
  }

  /** Возвращает true для нулевого значения. */
  isZero(): boolean {
    return this.coefficient === 0n;
  }

  /** Округляет до scale знаков методом half-up детерминированно. */
  round(scale: number): Decimal {
    if (!Number.isInteger(scale) || scale < 0) {
      throw new Error('Scale must be a non-negative integer');
    }
    if (scale >= this.scale) {
      return this;
    }
    const factor = 10n ** BigInt(this.scale - scale);
    let quotient = this.coefficient / factor;
    const remainder =
      this.coefficient < 0n ? -(this.coefficient % factor) : this.coefficient % factor;
    if (remainder * 2n >= factor) {
      quotient += this.coefficient < 0n ? -1n : 1n;
    }
    return Decimal.normalize(new Decimal(quotient, scale));
  }

  /** Возвращает каноническую строку для хранения и передачи через контракты. */
  toString(): string {
    if (this.coefficient === 0n) {
      return '0';
    }
    const negative = this.coefficient < 0n;
    const digits = (negative ? -this.coefficient : this.coefficient).toString();
    if (this.scale === 0) {
      return `${negative ? '-' : ''}${digits}`;
    }
    const padded = digits.padStart(this.scale + 1, '0');
    const splitAt = padded.length - this.scale;
    return `${negative ? '-' : ''}${padded.slice(0, splitAt)}.${padded.slice(splitAt)}`;
  }

  private static normalize(value: Decimal): Decimal {
    let coefficient = value.coefficient;
    let scale = value.scale;
    while (scale > 0 && coefficient % 10n === 0n) {
      coefficient /= 10n;
      scale -= 1;
    }
    return new Decimal(coefficient, scale);
  }

  private static align(left: Decimal, right: Decimal): [bigint, bigint, number] {
    const scale = Math.max(left.scale, right.scale);
    return [
      left.coefficient * 10n ** BigInt(scale - left.scale),
      right.coefficient * 10n ** BigInt(scale - right.scale),
      scale,
    ];
  }
}
