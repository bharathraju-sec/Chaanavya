// Starting a payment (Stage 14.04): the shopper's own pending order gets its payment attempt (14.03) and the
// provider's checkout for it. The amount is the attempt's, which is the saved order's grand total in paise;
// nothing the browser sends is read, so it cannot change what the provider is asked to collect.
//
// Once    the attempt row is locked while the provider is asked, so simultaneous requests open one provider
//         checkout; a retry rebuilds the session from the stored reference instead of opening another.
// Errors  a provider that cannot be reached or answers wrongly leaves the attempt without a reference
//         (nothing recorded) and the shopper may try again with the same key; nothing is ever guessed paid.
// Retry   (Stage 14.15) while an attempt is in progress every request gets it (a payment under way is a 409,
//         never a second attempt). A new attempt replaces ended ones only once Razorpay confirms nothing was
//         paid, authorized or is still in progress on their checkouts; otherwise nothing new is opened.
import type { PaymentAdapter } from "@chaanavya/contracts/integrations/payment-gateway"
import { PaymentAdapterError } from "@chaanavya/contracts/integrations/payment-gateway"
import type { IdempotencyKey, PaymentAttemptId, Shopper } from "@chaanavya/contracts/modules/common"
import { ApiError, UUID } from "../admin/api.ts"
import type { Db } from "../db/client.ts"
import { ownerWhere } from "../orders/intent.ts"
import { OPEN_ATTEMPT_STATUSES, openAttempt, recordProviderOrderRef } from "./attempts.ts"

/** Where a redirect checkout brings the buyer back (embedded checkouts ignore it). */
const RETURN_PATH = "/checkout/payment"

/**
 * Before a new attempt replaces ended ones (Stage 14.15): Razorpay keeps an ended attempt's order payable (an
 * old tab, a late UPI success), so each ended attempt that opened a checkout is asked about. Only failed tries
 * or no payment there make a new attempt safe. Money captured, authorized or in progress on an earlier
 * checkout refuses the new one (409) and is noted once for staff: paying again could charge the buyer twice.
 * A provider that cannot answer refuses it too (502, try again): the outcome is not known.
 */
async function assertEarlierAttemptsSettled(db: Db, adapter: PaymentAdapter, orderId: string) {
  const ended = await db.paymentAttempt.findMany({ where: { orderId, provider: adapter.provider, status: { in: ["failed", "expired"] }, providerOrderId: { not: null } }, select: { id: true, providerOrderId: true } })
  for (const earlier of ended) {
    let found
    try {
      found = await adapter.lookupPayment({ providerOrderId: earlier.providerOrderId!, providerPaymentId: null })
    } catch (error) {
      if (error instanceof PaymentAdapterError && error.kind === "not_found") continue
      if (error instanceof PaymentAdapterError) throw new ApiError(502, "unavailable", "the payment provider could not be checked; try again")
      throw error
    }
    if (found.status === "failed" && !found.capturedAmount) continue
    const correlationId = `retry:${earlier.id}`
    const noted = await db.auditEvent.findFirst({ where: { action: "payment.retry_blocked", correlationId }, select: { id: true } })
    if (!noted) {
      await db.auditEvent.create({ data: { action: "payment.retry_blocked", actorKind: "system", actorId: null, entityType: "order", entityId: orderId, reason: found.capturedAmount ? "earlier_attempt_captured" : "earlier_attempt_in_flight", after: { paymentAttemptId: earlier.id, providerPaymentId: found.providerPaymentId, status: found.status }, correlationId } })
    }
    throw new ApiError(409, "conflict", "a payment for this order may already have gone through; we are checking it", { payment: "earlier_attempt_unsettled" })
  }
}

export async function startPayment(db: Db, adapter: PaymentAdapter, owner: Shopper | null, orderId: string, key: string, { webUrl, now }: { webUrl: string; now?: Date }) {
  if (!owner || !UUID.test(orderId)) throw new ApiError(404, "not_found", "not found")
  const order = await db.order.findFirst({ where: { id: orderId, ...ownerWhere(owner) }, select: { id: true, number: true, quoteRef: true } })
  // Another shopper's order, or one not placed from a quote, is the same 404 as an unknown one.
  if (!order || order.quoteRef === null) throw new ApiError(404, "not_found", "not found")

  // A new attempt only when every earlier one's outcome is known and safe (Stage 14.15).
  const inProgress = await db.paymentAttempt.findFirst({ where: { orderId: order.id, status: { in: [...OPEN_ATTEMPT_STATUSES] } }, select: { id: true } })
  if (!inProgress) await assertEarlierAttemptsSettled(db, adapter, order.id)

  const { attempt, reused } = await openAttempt(db, { orderId: order.id, provider: adapter.provider, mode: adapter.mode, key, now })
  if (attempt.status !== "created") throw new ApiError(409, "conflict", "a payment for this order is already under way", { payment: attempt.status })

  try {
    return await db.$transaction(
      async tx => {
        // One provider checkout per attempt: whoever holds this lock asks the provider; the others wait and reuse it.
        const [locked] = await tx.$queryRaw<{ provider_order_id: string | null; status: string }[]>`SELECT provider_order_id, status::text AS status FROM "payment_attempt" WHERE id = ${attempt.id}::uuid FOR UPDATE`
        if (locked.status !== "created") throw new ApiError(409, "conflict", "a payment for this order is already under way", { payment: locked.status })
        const checkout = await adapter.createCheckout({
          attemptId: attempt.id as PaymentAttemptId,
          reference: order.number,
          amount: attempt.amount as { amountPaise: number; currency: "INR" },
          returnUrl: new URL(RETURN_PATH, webUrl).toString(),
          key: `attempt:${attempt.id}` as IdempotencyKey,
          existingProviderOrderId: locked.provider_order_id,
        })
        const stored = await recordProviderOrderRef(tx, attempt.id, checkout.providerOrderId)
        return { session: { attemptId: stored.id, provider: adapter.provider, providerOrderId: checkout.providerOrderId, amount: stored.amount, next: checkout.next }, reused: reused || locked.provider_order_id !== null }
      },
      { maxWait: 15_000, timeout: 20_000 },
    )
  } catch (error) {
    if (error instanceof PaymentAdapterError) {
      if (error.kind === "misconfigured") throw new ApiError(503, "unavailable", "payments are not available right now")
      throw new ApiError(502, "unavailable", "the payment provider could not open the checkout; try again")
    }
    throw error
  }
}
