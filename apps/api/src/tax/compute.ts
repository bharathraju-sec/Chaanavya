// GST worked out on the server (Stage 12.06). Pure: the caller passes the lines (catalogue prices,
// never the browser's), the bag discount, the tax profile (12.05) and the delivery state; nothing here
// reads the database or trusts a client amount. Every amount is a whole number of paise held as a
// bigint; there is no floating point anywhere.
//
// Owner decisions, 27 October 2026 (to be confirmed by the tax advisor with the worked examples in
// tests/security/tax/compute.test.mjs):
// Rounding  per line, to the nearest paisa, half up; the bag's tax is the sum of its lines.
// Halves    within the seller's state, CGST and SGST (UTGST in a union territory without a legislature)
//           are each worked out at half the rate and rounded separately, so they are always equal.
// Discount  a bag-level discount is shared across lines in proportion to their price, in whole paise,
//           the left-over paise going to the largest remainders (ties: earlier line first); tax is on
//           the discounted price.
//
// Supply    delivery in the seller's state: CGST + SGST/UTGST; anywhere else in India: IGST.
// Inclusive with GST-inclusive prices (decision 014, proposed) the shopper pays exactly the line price;
//           the tax is taken out of it: half = round(V x r / (2 x (10000 + r))), IGST =
//           round(V x r / (10000 + r)), taxable = V - tax.
// Exclusive otherwise tax is added: half = round(V x r / 20000), IGST = round(V x r / 10000).
// Missing   a category with no rate in the profile is refused, never taxed at zero.
// Shipping  (owner decision, 27 October 2026, Stage 12.09; advisor to confirm) the delivery fee is
//           shared across the lines in proportion to their value after discount, in whole paise by
//           the same largest-remainder rule, and each share is taxed at its line's rate. The fee
//           follows the price setting: with GST-inclusive prices it includes GST, otherwise GST is
//           added. A bag whose lines are all free shares the fee by list price, then equally.
import type { TaxClassificationV1, TaxComponent } from "@chaanavya/contracts/modules/money"
import { ApiError } from "../admin/api.ts"
import { stateCodeOf, type IndianStateCode } from "../checkout/region.ts"

export const ROUNDING = "line_half_up_v1" as const

/** Union territories without a legislature: UTGST instead of SGST. */
export const UTGST_TERRITORIES: ReadonlySet<IndianStateCode> = new Set(["IN-AN", "IN-CH", "IN-DH", "IN-LD", "IN-LA"])

export type TaxProfileForCompute = {
  id: string
  approved: boolean
  sellerStateCode: string
  pricesIncludeTax: boolean
  rates: { taxCategory: string; hsnCode: string; rateBasisPoints: number }[]
}

export type TaxableLine = { key: string; taxCategory: string; unitPricePaise: bigint; quantity: number }

export type TaxedComponent = { component: TaxComponent; rateBasisPoints: number; amountPaise: bigint }

export type TaxedLine = {
  key: string
  quantity: number
  grossPaise: bigint
  discountPaise: bigint
  taxablePaise: bigint
  taxPaise: bigint
  totalPaise: bigint
  tax: TaxedComponent[]
  classification: TaxClassificationV1
}

export type TaxedShipping = {
  feePaise: bigint
  taxablePaise: bigint
  taxPaise: bigint
  /** What the shopper pays for delivery: the fee, plus GST when prices exclude it. */
  totalPaise: bigint
  /** The fee's GST by component and rate, summed over the shares. */
  tax: TaxedComponent[]
  shares: { key: string; sharePaise: bigint; tax: TaxedComponent[] }[]
}

export type TaxResult = {
  supply: "intra" | "inter"
  lines: TaxedLine[]
  /** GST on the delivery fee; a zero fee gives zero shares. Not included in the goods totals below. */
  shipping: TaxedShipping
  subtotalPaise: bigint
  discountPaise: bigint
  taxablePaise: bigint
  taxPaise: bigint
  totalPaise: bigint
  rounding: typeof ROUNDING
}

/** n / d rounded to the nearest whole number, halves up. n >= 0, d > 0. */
export function roundHalfUp(n: bigint, d: bigint): bigint {
  if (n < 0n || d <= 0n) throw new RangeError("roundHalfUp needs n >= 0 and d > 0")
  return (2n * n + d) / (2n * d)
}

/**
 * Shares `total` paise across `weights` in proportion, whole paise only, summing exactly to `total`.
 * Largest remainders take the left-over paise; ties go to the earlier entry.
 */
export function allocate(total: bigint, weights: readonly bigint[]): bigint[] {
  const sum = weights.reduce((a, b) => a + b, 0n)
  if (total < 0n || weights.some(w => w < 0n)) throw new RangeError("allocate needs non-negative amounts")
  if (total === 0n || sum === 0n) return weights.map(() => 0n)
  if (total > sum) throw new RangeError("cannot share more than the total weight")
  return split(total, weights)
}

/** Shares `total` in proportion to `weights` (any total), whole paise, largest remainders first. */
function split(total: bigint, weights: readonly bigint[]): bigint[] {
  const sum = weights.reduce((a, b) => a + b, 0n)
  if (total === 0n || sum === 0n) return weights.map(() => 0n)
  const shares = weights.map(w => (total * w) / sum)
  let left = total - shares.reduce((a, b) => a + b, 0n)
  const order = weights.map((w, i) => ({ i, remainder: (total * w) % sum })).sort((a, b) => (a.remainder === b.remainder ? a.i - b.i : a.remainder > b.remainder ? -1 : 1))
  for (const { i } of order) {
    if (left === 0n) break
    shares[i]! += 1n
    left -= 1n
  }
  return shares
}

function taxOf(value: bigint, rate: bigint, inclusive: boolean, supply: "intra" | "inter", local: TaxComponent): TaxedComponent[] {
  const r = Number(rate)
  if (supply === "inter") {
    const igst = inclusive ? roundHalfUp(value * rate, 10000n + rate) : roundHalfUp(value * rate, 10000n)
    return [{ component: "IGST", rateBasisPoints: r, amountPaise: igst }]
  }
  const half = inclusive ? roundHalfUp(value * rate, 2n * (10000n + rate)) : roundHalfUp(value * rate, 20000n)
  // A half rate can be a fraction of a basis point (an odd rate); it is shown as the full rate halved.
  return [
    { component: "CGST", rateBasisPoints: r / 2, amountPaise: half },
    { component: local, rateBasisPoints: r / 2, amountPaise: half },
  ]
}

/** Works out GST for a bag. Refuses bad input instead of guessing. */
export function computeTax(input: { lines: readonly TaxableLine[]; discountPaise: bigint; profile: TaxProfileForCompute; deliveryStateCode: string; shippingFeePaise?: bigint }): TaxResult {
  const { profile } = input
  const seller = stateCodeOf(profile.sellerStateCode)
  const delivery = stateCodeOf(input.deliveryStateCode)
  if (!seller) throw new ApiError(409, "conflict", "the tax profile's seller state is not valid", { sellerStateCode: "invalid" })
  if (!delivery) throw new ApiError(400, "invalid_request", "the delivery state is not valid", { deliveryStateCode: "invalid" })
  const rates = new Map(profile.rates.map(r => [r.taxCategory, r]))
  const problems: Record<string, string> = {}
  for (const [i, line] of input.lines.entries()) {
    if (!Number.isSafeInteger(line.quantity) || line.quantity < 1) problems[`lines.${i}.quantity`] = "invalid"
    if (typeof line.unitPricePaise !== "bigint" || line.unitPricePaise < 0n) problems[`lines.${i}.unitPricePaise`] = "invalid"
    const rate = rates.get(line.taxCategory)
    if (!rate) problems[`tax.${line.taxCategory}`] = "unmapped_category"
    else if (!Number.isInteger(rate.rateBasisPoints) || rate.rateBasisPoints < 0 || rate.rateBasisPoints > 4000) problems[`tax.${line.taxCategory}`] = "invalid_rate"
  }
  if (Object.keys(problems).length > 0) throw new ApiError(409, "conflict", "tax cannot be worked out for this bag", problems)

  const gross = input.lines.map(l => l.unitPricePaise * BigInt(l.quantity))
  const subtotal = gross.reduce((a, b) => a + b, 0n)
  if (input.discountPaise < 0n || input.discountPaise > subtotal) throw new ApiError(409, "conflict", "the discount is larger than the bag", { discount: "invalid" })
  const fee = input.shippingFeePaise ?? 0n
  if (typeof fee !== "bigint" || fee < 0n) throw new ApiError(409, "conflict", "the delivery fee is not valid", { shippingFee: "invalid" })
  if (fee > 0n && input.lines.length === 0) throw new ApiError(409, "conflict", "a delivery fee needs a line to share it", { shippingFee: "invalid" })
  const discounts = allocate(input.discountPaise, gross)
  const supply = seller === delivery ? "intra" : "inter"
  const local: TaxComponent = UTGST_TERRITORIES.has(seller) ? "UTGST" : "SGST"

  const lines = input.lines.map((line, i): TaxedLine => {
    const rate = rates.get(line.taxCategory)!
    const value = gross[i]! - discounts[i]!
    const tax = taxOf(value, BigInt(rate.rateBasisPoints), profile.pricesIncludeTax, supply, local)
    const taxPaise = tax.reduce((a, c) => a + c.amountPaise, 0n)
    const taxablePaise = profile.pricesIncludeTax ? value - taxPaise : value
    return {
      key: line.key,
      quantity: line.quantity,
      grossPaise: gross[i]!,
      discountPaise: discounts[i]!,
      taxablePaise,
      taxPaise,
      totalPaise: taxablePaise + taxPaise,
      tax,
      classification: {
        taxProfileId: profile.id,
        profileApproved: profile.approved,
        taxCategory: line.taxCategory,
        hsnCode: rate.hsnCode,
        rateBasisPoints: rate.rateBasisPoints,
        supply,
        sellerStateCode: seller,
        deliveryStateCode: delivery,
        pricesIncludeTax: profile.pricesIncludeTax,
        rounding: ROUNDING,
      },
    }
  })
  const sum = (pick: (l: TaxedLine) => bigint) => lines.reduce((a, l) => a + pick(l), 0n)

  // The delivery fee, shared by value after discount, each share at its line's rate.
  const values = lines.map(l => l.grossPaise - l.discountPaise)
  const weights = values.some(v => v > 0n) ? values : gross.some(g => g > 0n) ? gross : lines.map(() => 1n)
  const shares = split(fee, weights).map((sharePaise, i) => ({
    key: lines[i]!.key,
    sharePaise,
    tax: taxOf(sharePaise, BigInt(lines[i]!.classification.rateBasisPoints), profile.pricesIncludeTax, supply, local),
  }))
  const byComponent = new Map<string, TaxedComponent>()
  for (const c of shares.flatMap(s => s.tax)) {
    const k = `${c.component}:${c.rateBasisPoints}`
    const seen = byComponent.get(k)
    byComponent.set(k, seen ? { ...seen, amountPaise: seen.amountPaise + c.amountPaise } : { ...c })
  }
  const shippingTax = shares.reduce((a, s) => a + s.tax.reduce((b, c) => b + c.amountPaise, 0n), 0n)
  const shippingTaxable = profile.pricesIncludeTax ? fee - shippingTax : fee
  const shipping: TaxedShipping = {
    feePaise: fee,
    taxablePaise: shippingTaxable,
    taxPaise: shippingTax,
    totalPaise: shippingTaxable + shippingTax,
    tax: [...byComponent.values()].filter(c => c.amountPaise > 0n || fee > 0n),
    shares,
  }

  return {
    supply,
    lines,
    shipping,
    subtotalPaise: subtotal,
    discountPaise: input.discountPaise,
    taxablePaise: sum(l => l.taxablePaise),
    taxPaise: sum(l => l.taxPaise),
    totalPaise: sum(l => l.totalPaise),
    rounding: ROUNDING,
  }
}
