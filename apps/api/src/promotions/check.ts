// Loads what the promotion validity engine (./validity.ts) needs from the database and asks it
// (Stage 11.09). The shopper comes from the session (cart owner), never from the request; the
// subtotal from the server-side bag. Nothing is written: applying a code to a bag is Stage 11.10,
// and counting a use happens when an order takes the code.
import type { Shopper } from "@chaanavya/contracts/modules/common"
import type { Db, Tx } from "../db/client.ts"
import { toPaise } from "../db/money.ts"
import { evaluatePromotion, normaliseCode, type PromotionDecision, type PromotionShopper } from "./validity.ts"

/** Orders that count as a use of a code by a customer: every one except cancelled orders. */
const COUNTED_ORDER = { status: { not: "cancelled" } } as const

type PromotionRow = NonNullable<Awaited<ReturnType<Db["promotion"]["findUnique"]>>>

async function decide(db: Db | Tx, row: PromotionRow | null, input: { owner: Shopper | null; subtotalPaise: number; currency?: string; now?: Date }): Promise<PromotionDecision> {
  const now = input.now ?? new Date()
  const promotion = row && {
    ...row,
    amountOffPaise: row.amountOffPaise === null ? null : toPaise(row.amountOffPaise),
    minSubtotalPaise: row.minSubtotalPaise === null ? null : toPaise(row.minSubtotalPaise),
  }
  // A customer is counted by account, a guest by guest session; no session means no orders yet.
  const owner = input.owner
  const whose = owner?.kind === "customer" ? { userId: owner.customerId } : owner?.kind === "guest" ? { guestSessionId: owner.guestSessionId } : null
  const used = row?.perCustomerLimit != null && whose ? await db.order.count({ where: { promotionId: row.id, ...whose, ...COUNTED_ORDER } }) : 0
  const shopper: PromotionShopper = { usedByThisShopper: used }
  return evaluatePromotion(promotion, { now, subtotalPaise: input.subtotalPaise, currency: input.currency ?? "INR", shopper })
}

/** Checks a code the shopper typed. */
export async function checkPromotion(db: Db | Tx, input: { code: unknown; owner: Shopper | null; subtotalPaise: number; currency?: string; now?: Date }): Promise<PromotionDecision> {
  const code = normaliseCode(input.code)
  if (!code) return { ok: false, reason: "not_found" }
  return decide(db, await db.promotion.findUnique({ where: { code } }), input)
}

/** Checks the promotion already applied to a bag, again (time passes and the bag changes). */
export async function checkAppliedPromotion(db: Db | Tx, input: { promotionId: string; owner: Shopper | null; subtotalPaise: number; now?: Date }) {
  const row = await db.promotion.findUnique({ where: { id: input.promotionId } })
  return { code: row?.code ?? null, decision: await decide(db, row, input) }
}
