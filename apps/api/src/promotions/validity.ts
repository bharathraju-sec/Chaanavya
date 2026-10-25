// Promotion validity engine (Stage 11.09). Decides, on the server, whether a promotion code can be
// used for this shopper and this subtotal, and how much it takes off. Pure: the caller loads the
// promotion and the shopper's usage (./check.ts), so every rule is testable without a database.
// Nothing here trusts the browser: it never receives a discount or a total from the request.
//
// Codes       trimmed and upper-cased; 3 to 32 letters, digits, - or _. Anything else, an unknown
//             code and a code that is switched off all answer not_found, so drafts and typos look
//             the same and codes cannot be discovered by trying.
// Window      usable from starts_at (inclusive) until ends_at (exclusive); before is not_started,
//             after is expired.
// Minimum     the bag subtotal (catalogue prices, unavailable lines left out) must reach
//             min_subtotal_paise; an empty bag never qualifies.
// Total limit usage_count (orders placed with the code, counted when an order takes it) must be
//             below usage_limit.
// Per person  per_customer_limit counts the shopper's orders with the code that are not cancelled,
//             including ones still awaiting payment, so parallel checkouts cannot exceed it. A
//             signed-in customer is counted by account; a guest (allowed, owner decision of
//             25 October 2026) by guest session, which a shopper can get round by starting a new
//             one. A shopper with no session has no orders yet.
// Discount    percent: floor(subtotal x basis points / 10000); fixed amount: the amount, at most
//             the subtotal. Integer paise only, never more than the subtotal, never negative.
//             Only INR is sold, and a code in another currency is refused.
export const PROMO_CODE = /^[A-Z0-9_-]{3,32}$/

export type PromotionRecord = {
  id: string
  code: string
  kind: "percent" | "fixed_amount"
  percentBasisPoints: number | null
  amountOffPaise: number | null
  minSubtotalPaise: number | null
  currency: string
  startsAt: Date
  endsAt: Date | null
  usageLimit: number | null
  perCustomerLimit: number | null
  usageCount: number
  active: boolean
}

/** How many of this shopper's orders (by account, or by guest session) already used the code. */
export type PromotionShopper = { usedByThisShopper: number }

export type PromotionRefusal = "not_found" | "not_started" | "expired" | "minimum_not_met" | "usage_limit_reached" | "per_customer_limit_reached" | "currency_mismatch"

export type PromotionDecision = { ok: true; promotionId: string; code: string; discountPaise: number } | { ok: false; reason: PromotionRefusal }

/** The canonical form of a code a shopper typed, or null when it cannot be a code. */
export function normaliseCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const code = raw.trim().toUpperCase()
  return PROMO_CODE.test(code) ? code : null
}

const refuse = (reason: PromotionRefusal): PromotionDecision => ({ ok: false, reason })

/** Whether `promotion` (null when no row matched the code) applies to this shopper and subtotal at `now`. */
export function evaluatePromotion(promotion: PromotionRecord | null, input: { now: Date; subtotalPaise: number; currency: string; shopper: PromotionShopper }): PromotionDecision {
  if (!promotion || !promotion.active) return refuse("not_found")
  if (!Number.isSafeInteger(input.subtotalPaise) || input.subtotalPaise < 0) throw new Error("subtotal must be whole paise")
  if (input.now < promotion.startsAt) return refuse("not_started")
  if (promotion.endsAt && input.now >= promotion.endsAt) return refuse("expired")
  if (promotion.currency !== input.currency) return refuse("currency_mismatch")
  if (promotion.usageLimit !== null && promotion.usageCount >= promotion.usageLimit) return refuse("usage_limit_reached")
  if (promotion.perCustomerLimit !== null && input.shopper.usedByThisShopper >= promotion.perCustomerLimit) return refuse("per_customer_limit_reached")
  if (input.subtotalPaise <= 0 || input.subtotalPaise < (promotion.minSubtotalPaise ?? 0)) return refuse("minimum_not_met")

  const discountPaise =
    promotion.kind === "percent"
      ? Math.floor((input.subtotalPaise * (promotion.percentBasisPoints ?? 0)) / 10_000)
      : Math.min(promotion.amountOffPaise ?? 0, input.subtotalPaise)
  if (!Number.isSafeInteger(discountPaise) || discountPaise <= 0) return refuse("minimum_not_met")
  return { ok: true, promotionId: promotion.id, code: promotion.code, discountPaise }
}
