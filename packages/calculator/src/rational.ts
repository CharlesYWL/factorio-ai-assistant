export class Rational {
  public static readonly ZERO = new Rational(0n, 1n);
  public static readonly ONE = new Rational(1n, 1n);

  readonly #numerator: bigint;
  readonly #denominator: bigint;

  private constructor(numerator: bigint, denominator: bigint) {
    if (denominator === 0n) {
      throw new Error("Rational denominator must not be zero");
    }

    const sign = denominator < 0n ? -1n : 1n;
    const divisor = greatestCommonDivisor(numerator, denominator);
    this.#numerator = (numerator / divisor) * sign;
    this.#denominator = (denominator / divisor) * sign;
  }

  public static from(value: number): Rational {
    if (!Number.isFinite(value)) {
      throw new Error("Rational value must be finite");
    }

    const text = value.toString().toLowerCase();
    const [coefficient = "", exponentText] = text.split("e");
    const exponent = exponentText === undefined ? 0 : Number(exponentText);
    const negative = coefficient.startsWith("-");
    const unsigned = negative ? coefficient.slice(1) : coefficient;
    const [integer = "0", fraction = ""] = unsigned.split(".");
    const digits = `${integer}${fraction}`;
    let numerator = BigInt(digits.length === 0 ? "0" : digits);
    let denominator = 10n ** BigInt(fraction.length);

    if (exponent > 0) {
      numerator *= 10n ** BigInt(exponent);
    } else if (exponent < 0) {
      denominator *= 10n ** BigInt(-exponent);
    }

    return new Rational(negative ? -numerator : numerator, denominator);
  }

  public add(other: Rational): Rational {
    return new Rational(
      this.#numerator * other.#denominator +
        other.#numerator * this.#denominator,
      this.#denominator * other.#denominator,
    );
  }

  public subtract(other: Rational): Rational {
    return new Rational(
      this.#numerator * other.#denominator -
        other.#numerator * this.#denominator,
      this.#denominator * other.#denominator,
    );
  }

  public multiply(other: Rational): Rational {
    return new Rational(
      this.#numerator * other.#numerator,
      this.#denominator * other.#denominator,
    );
  }

  public divide(other: Rational): Rational {
    if (other.isZero()) {
      throw new Error("Cannot divide by zero");
    }

    return new Rational(
      this.#numerator * other.#denominator,
      this.#denominator * other.#numerator,
    );
  }

  public negate(): Rational {
    return new Rational(-this.#numerator, this.#denominator);
  }

  public compare(other: Rational): number {
    const difference =
      this.#numerator * other.#denominator -
      other.#numerator * this.#denominator;
    return difference < 0n ? -1 : difference > 0n ? 1 : 0;
  }

  public min(other: Rational): Rational {
    return this.compare(other) <= 0 ? this : other;
  }

  public max(other: Rational): Rational {
    return this.compare(other) >= 0 ? this : other;
  }

  public isZero(): boolean {
    return this.#numerator === 0n;
  }

  public isNegative(): boolean {
    return this.#numerator < 0n;
  }

  public ceil(): number {
    const quotient = this.#numerator / this.#denominator;
    const remainder = this.#numerator % this.#denominator;
    return Number(remainder > 0n ? quotient + 1n : quotient);
  }

  public toNumber(): number {
    return Number(this.#numerator) / Number(this.#denominator);
  }

  public toFraction(): string {
    return this.#denominator === 1n
      ? this.#numerator.toString()
      : `${this.#numerator}/${this.#denominator}`;
  }
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;

  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }

  return a === 0n ? 1n : a;
}
