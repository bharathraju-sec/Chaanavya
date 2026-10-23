// Conversions between database money (bigint paise) and contract money (number paise).
// Postgres bigint arrives as a JavaScript bigint; contracts use number, which is exact only up
// to Number.MAX_SAFE_INTEGER paise (about 90 trillion rupees). Anything outside that throws
// instead of silently losing precision. No floats anywhere.

export class MoneyPrecisionError extends Error {}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)

/** Database to contract. */
export function toPaise(value: bigint): number {
  if (value < BigInt(0) || value > MAX_SAFE) throw new MoneyPrecisionError("amount outside the safe paise range")
  return Number(value)
}

/** Contract to database. Rejects fractions, negatives, NaN and unsafe integers. */
export function fromPaise(value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 0) throw new MoneyPrecisionError("amount must be a non-negative integer number of paise")
  return BigInt(value)
}

/** Exact sum in bigint, for totals that may exceed the safe number range. */
export const sumPaise = (values: readonly bigint[]) => values.reduce((total, value) => total + value, BigInt(0))

/** Paise to display Money; shared with the web host. */
export { toDisplayMoney } from "@chaanavya/shared/money-display"
