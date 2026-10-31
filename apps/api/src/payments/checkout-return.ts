// The browser's report from the provider's checkout (Stage 14.07). When the buyer finishes in the
// provider's window, the pay page sends us what the window handed it. That report is an untrusted signal:
// anyone can send any text, so it is only read, never acted on.
//
// Shape    a flat JSON object of a few short strings, then the adapter's own check (the provider's fields,
//          in its formats, for the provider order we stored). Anything else is a 400.
// Signed   the provider's signature over the order we stored and the payment it names (Stage 14.08); a
//          tampered payment id or signature is a 400.
// Owner    only the shopper's own order, and only one whose checkout was opened; another shopper's order
//          is the same 404 as an unknown one.
// Nothing  is written. The order and its payment move only on what the provider itself says (a verified
//          event or lookup, later Stage 14 steps). The answer is our own record of the order, so a page
//          that reports success is still told "confirming" until the provider confirms it.
import type { PaymentAdapter } from "@chaanavya/contracts/integrations/payment-gateway"
import { PaymentAdapterError } from "@chaanavya/contracts/integrations/payment-gateway"
import type { Shopper } from "@chaanavya/contracts/modules/common"
import { ApiError, UUID } from "../admin/api.ts"
import type { Db } from "../db/client.ts"
import { ownerWhere } from "../orders/intent.ts"

/** Bounds on the report, before any provider rule: a few fields of short text. */
const MAX_FIELDS = 8
const FIELD_NAME = /^[a-z][a-z0-9_]{0,39}$/
const MAX_VALUE = 256

export type CheckoutOutcome = "paid" | "confirming" | "not_paid"
export type CheckoutReturnView = { orderId: string; orderStatus: string; paymentStatus: string; outcome: CheckoutOutcome; verified: true }

/** The shape every provider's report must have; null when it has not. */
function flatStrings(body: Record<string, unknown>): Record<string, string> | null {
  const entries = Object.entries(body)
  if (entries.length === 0 || entries.length > MAX_FIELDS) return null
  for (const [name, value] of entries) if (!FIELD_NAME.test(name) || typeof value !== "string" || value.length === 0 || value.length > MAX_VALUE) return null
  return Object.fromEntries(entries) as Record<string, string>
}

/** What the shopper is told: from our records only. */
function outcomeOf(orderStatus: string, paymentStatus: string): CheckoutOutcome {
  if (orderStatus === "confirmed" || orderStatus === "completed") return "paid"
  if (paymentStatus === "failed" || paymentStatus === "expired" || orderStatus === "cancelled") return "not_paid"
  return "confirming"
}

export async function receiveCheckoutReturn(db: Db, adapter: PaymentAdapter, owner: Shopper | null, orderId: string, body: Record<string, unknown>): Promise<CheckoutReturnView> {
  if (!owner || !UUID.test(orderId)) throw new ApiError(404, "not_found", "not found")
  const order = await db.order.findFirst({ where: { id: orderId, ...ownerWhere(owner) }, select: { id: true, status: true, quoteRef: true } })
  if (!order || order.quoteRef === null) throw new ApiError(404, "not_found", "not found")

  const returned = flatStrings(body)
  if (!returned) throw new ApiError(400, "invalid_request", "the checkout return could not be read")

  // The checkout this report can belong to: the order's latest attempt with this provider that opened one.
  const attempt = await db.paymentAttempt.findFirst({
    where: { orderId: order.id, provider: adapter.provider, providerOrderId: { not: null } },
    orderBy: { createdAt: "desc" },
    select: { status: true, providerOrderId: true },
  })
  if (!attempt?.providerOrderId) throw new ApiError(409, "conflict", "no checkout was opened for this order")

  let check
  try {
    check = await adapter.verifyReturn({ storedProviderOrderId: attempt.providerOrderId, returned })
  } catch (error) {
    if (error instanceof PaymentAdapterError && error.kind === "rejected") throw new ApiError(400, "invalid_request", "the checkout return could not be read")
    throw error
  }
  // A report the provider did not sign for this checkout (Stage 14.08) is refused outright.
  if (!check.verified) throw new ApiError(400, "invalid_request", "the checkout return could not be verified", { signature: "mismatch" })
  // Even a verified report only says the buyer finished in the provider's window: the answer is what we hold.
  // Nothing is recorded or moved here; the payment moves on what the provider itself reports (later steps).
  return { orderId: order.id, orderStatus: order.status, paymentStatus: attempt.status, outcome: outcomeOf(order.status, attempt.status), verified: true }
}
