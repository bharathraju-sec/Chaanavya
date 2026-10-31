// Failed, cancelled and expired payments (Stage 14.13). Razorpay keeps an order open after a failed try: the
// buyer can try again in the same window, with another card or UPI app, and that later try may succeed. So:
//
// Failed try  a verified payment.failed event (failure-handler.ts) is recorded for staff and ends nothing:
//             the attempt stays open, the stock stays held, and the pay page reopens the same checkout.
// Closing     an open attempt ends only when its order is given up: the shopper cancels it, or its payment
//             window ends (the reconciliation job, Stage 14.14). Razorpay is asked first:
//               a payment captured, authorized or still in progress  -> nothing is closed (money in flight;
//                                                                       the capture flow decides);
//               only failed tries                                    -> the attempt ends `failed`;
//               no payment at all (or no checkout was ever opened)   -> the attempt ends `expired`.
//             With the attempt closed, the Stage 13.09 cancellation releases the stock and cancels the order.
// Never paid  nothing here records money, confirms an order or allocates stock. A capture that reaches an
//             attempt closed this way (paid in another tab at the last moment) is not applied: the capture
//             bridge keeps it for reconciliation and a refund (13.10, 13.14).
import { PaymentAdapterError, type PaymentAdapter } from "@chaanavya/contracts/integrations/payment-gateway"
import type { Shopper } from "@chaanavya/contracts/modules/common"
import { ApiError, UUID } from "../admin/api.ts"
import type { Db } from "../db/client.ts"
import { transitionPayment } from "../db/transitions.ts"
import { ownerWhere } from "../orders/intent.ts"
import { shopperCancelsOrder } from "../orders/cancel.ts"

export type CloseReason = "shopper_cancelled" | "payment_window_ended"
export type CloseOutcome = "failed" | "expired" | "money_in_flight" | "not_open"

/** What Razorpay holds for the attempt's order: no payment, only failed tries, or money that may go through. */
async function providerSays(adapter: PaymentAdapter, providerOrderId: string | null): Promise<"none" | "failed" | "in_flight"> {
  if (!providerOrderId) return "none"
  try {
    const p = await adapter.lookupPayment({ providerOrderId, providerPaymentId: null })
    if (p.providerOrderId !== providerOrderId) return "in_flight"
    if (p.status === "failed" && !p.capturedAmount) return "failed"
    return "in_flight"
  } catch (error) {
    if (error instanceof PaymentAdapterError && error.kind === "not_found") return "none"
    throw error
  }
}

/** Ends one open attempt by what Razorpay says. Safe to repeat and to race with a capture. */
export async function closeOpenAttempt(db: Db, adapter: PaymentAdapter, attemptId: string, { reason, correlationId }: { reason: CloseReason; correlationId: string }): Promise<CloseOutcome> {
  const before = await db.paymentAttempt.findUnique({ where: { id: attemptId }, select: { status: true, providerOrderId: true, provider: true } })
  if (!before || (before.status !== "created" && before.status !== "pending_reconciliation") || before.provider !== adapter.provider) return "not_open"
  // Asked outside the transaction (a network call); the attempt is re-checked under its locks below.
  const said = await providerSays(adapter, before.providerOrderId)
  if (said === "in_flight") return "money_in_flight"

  return db.$transaction(
    async tx => {
      // The order, then the attempt: the same order the capture bridge locks in, so the two never deadlock.
      const [row] = await tx.$queryRaw<{ order_id: string }[]>`SELECT order_id FROM "payment_attempt" WHERE id = ${attemptId}::uuid`
      await tx.$queryRaw`SELECT id FROM "order" WHERE id = ${row.order_id}::uuid FOR NO KEY UPDATE`
      const [now] = await tx.$queryRaw<{ status: string }[]>`SELECT status::text AS status FROM "payment_attempt" WHERE id = ${attemptId}::uuid FOR UPDATE`
      if (now.status !== "created" && now.status !== "pending_reconciliation") return "not_open" as const
      const from = now.status as "created" | "pending_reconciliation"
      const to = said === "failed" ? "failed" : "expired"
      // Razorpay's word moves it: as the provider, except a created attempt nobody paid, which the system closes
      // when its session ends (the machine's created -> expired rule).
      const actor = to === "expired" && from === "created" ? { kind: "system" as const, id: null } : { kind: "provider" as const, id: adapter.provider }
      await transitionPayment(tx, { paymentAttemptId: attemptId, from, to, facts: {}, actor, correlationId: `${correlationId}:${reason}` })
      return to
    },
    { maxWait: 10_000, timeout: 15_000 },
  )
}

/**
 * The shopper cancels their own unpaid order (Stage 13.09), now also when a checkout was opened: each open
 * attempt is first closed by what Razorpay says. Money in flight leaves the order pending
 * (awaiting_payment_outcome), exactly as before.
 */
export async function shopperCancelsWithPayment(db: Db, adapter: PaymentAdapter | null, owner: Shopper | null, orderId: string, correlationId: string) {
  if (!owner || !UUID.test(orderId)) throw new ApiError(404, "not_found", "not found")
  if (adapter) {
    // Only the shopper's own order is looked at; another's is the same 404 as before, from the cancellation.
    const open = await db.paymentAttempt.findMany({ where: { order: { id: orderId, ...ownerWhere(owner) }, status: { in: ["created", "pending_reconciliation"] } }, select: { id: true } })
    for (const attempt of open) await closeOpenAttempt(db, adapter, attempt.id, { reason: "shopper_cancelled", correlationId })
  }
  return shopperCancelsOrder(db, owner, orderId, correlationId)
}
