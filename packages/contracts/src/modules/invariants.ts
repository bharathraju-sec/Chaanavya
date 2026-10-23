import type { DomainErrorCode } from "./common.ts"
import type { MoneyPaise } from "./money.ts"

// Reference implementations of the commerce invariants (Stage 02). They pin the required
// behaviour for the database-backed modules built in Stages 08, 11, 12 and 13, and are exercised
// by tests/contracts/. They are pure functions over values, not a pricing or stock service.
//
// Runtime code, but self-contained (type-only imports), so Node can load it directly in tests.

/** Cart limits: 99 per line, 20 lines. */
export const MAX_LINE_QUANTITY = 99
export const MAX_CART_LINES = 20

export type Checked<T> = { ok: true; value: T } | { ok: false; code: DomainErrorCode; detail: string }

const fail = <T,>(code: DomainErrorCode, detail: string): Checked<T> => ({ ok: false, code, detail })

/** Integer paise, non-negative, exactly representable. */
export const isPaise = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0

/** Server-side catalogue facts for one variant. Never built from request data. */
export type PricedVariant = { unitPricePaise: number; sellable: boolean }

export type PricedLine = { variantId: string; quantity: number; unitPricePaise: number; lineSubtotalPaise: number }

/**
 * Invariant: prices are set by the server. Reads only `variantId` and `quantity` from each
 * client line; any price, total, discount or currency the client sends is ignored.
 */
export function priceLines(input: unknown, catalogue: ReadonlyMap<string, PricedVariant>): Checked<{ lines: PricedLine[]; subtotalPaise: number }> {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_CART_LINES) return fail("invalid_input", "line count")
  const lines: PricedLine[] = []
  const seen = new Set<string>()
  let subtotalPaise = 0
  for (const raw of input) {
    const variantId = (raw as { variantId?: unknown } | null)?.variantId
    const quantity = (raw as { quantity?: unknown } | null)?.quantity
    if (typeof variantId !== "string" || variantId.length === 0) return fail("invalid_input", "variant id")
    if (!Number.isInteger(quantity) || (quantity as number) < 1 || (quantity as number) > MAX_LINE_QUANTITY) return fail("invalid_input", `quantity for ${variantId}`)
    if (seen.has(variantId)) return fail("invalid_input", `duplicate line for ${variantId}`)
    seen.add(variantId)
    const variant = catalogue.get(variantId)
    if (!variant) return fail("not_found", variantId)
    if (!variant.sellable) return fail("out_of_stock", variantId)
    if (!isPaise(variant.unitPricePaise)) return fail("invalid_input", `catalogue price for ${variantId}`)
    const lineSubtotalPaise = variant.unitPricePaise * (quantity as number)
    subtotalPaise += lineSubtotalPaise
    if (!isPaise(lineSubtotalPaise) || !isPaise(subtotalPaise)) return fail("invalid_input", "amount overflow")
    lines.push({ variantId, quantity: quantity as number, unitPricePaise: variant.unitPricePaise, lineSubtotalPaise })
  }
  return { ok: true, value: { lines, subtotalPaise } }
}

export type TotalsInput = { subtotalPaise: number; discountPaise: number; shippingFeePaise: number; taxPaise: number; pricesIncludeTax: boolean }

/** Grand total in integer paise. Tax is added only when catalogue prices exclude it (decision 014). */
export function computeGrandTotal(input: TotalsInput): Checked<number> {
  const { subtotalPaise, discountPaise, shippingFeePaise, taxPaise, pricesIncludeTax } = input
  if (![subtotalPaise, discountPaise, shippingFeePaise, taxPaise].every(isPaise)) return fail("invalid_input", "amounts must be integer paise")
  if (discountPaise > subtotalPaise) return fail("invalid_input", "discount exceeds subtotal")
  const total = subtotalPaise - discountPaise + shippingFeePaise + (pricesIncludeTax ? 0 : taxPaise)
  return isPaise(total) ? { ok: true, value: total } : fail("invalid_input", "amount overflow")
}

/**
 * The client may echo the total it was shown. It is compared with the server amount and a
 * mismatch rejects the request; the client value is never adopted.
 */
export function matchesServerAmount(clientEcho: unknown, server: MoneyPaise): boolean {
  const echo = clientEcho as { amountPaise?: unknown; currency?: unknown } | null
  return !!echo && echo.amountPaise === server.amountPaise && echo.currency === server.currency
}

export type StockBalance = { onHand: number; reserved: number; allocated: number }

/** available = onHand - reserved - allocated. */
export const availableUnits = (balance: StockBalance) => balance.onHand - balance.reserved - balance.allocated

const validBalance = (b: StockBalance) => [b.onHand, b.reserved, b.allocated].every(n => Number.isSafeInteger(n) && n >= 0) && availableUnits(b) >= 0

/**
 * Invariant: no overselling. Reserves every line or none. Returns new balances and leaves the
 * input untouched. Stage 08 enforces the same rule with row locks or conditional updates.
 */
export function reserveAll(balances: ReadonlyMap<string, StockBalance>, lines: readonly { sku: string; quantity: number }[]): Checked<Map<string, StockBalance>> {
  if (lines.length === 0) return fail("invalid_input", "no lines")
  const next = new Map<string, StockBalance>()
  for (const [sku, balance] of balances) next.set(sku, { ...balance })
  const shortages: string[] = []
  for (const { sku, quantity } of lines) {
    if (!Number.isInteger(quantity) || quantity < 1) return fail("invalid_input", `quantity for ${sku}`)
    const balance = next.get(sku)
    if (!balance || !validBalance(balance)) return fail("not_found", sku)
    if (availableUnits(balance) < quantity) shortages.push(sku)
    else balance.reserved += quantity
  }
  return shortages.length ? fail("out_of_stock", shortages.join(",")) : { ok: true, value: next }
}
