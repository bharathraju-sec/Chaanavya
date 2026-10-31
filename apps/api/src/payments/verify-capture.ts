// Checking a reported capture against Razorpay and against the order (Stage 14.11). A webhook (or a browser)
// only says a payment was captured; before anything relies on it, the payment module asks the provider itself
// (the adapter's lookupPayment) and compares the provider's own answer with what we stored:
//
//   order     the provider's payment is for the provider order we opened for this attempt
//   payment   and is the payment the event names
//   captured  the provider says it is captured (authorized, failed or still pending is not a capture)
//   INR       the provider reports INR, the order's currency
//   paise     the captured amount is exactly the attempt's amount, which is the order's grand total
//
// The event's own amount is never used: only the provider's answer. The verdict says what may happen next:
//   verified   the capture can complete the order (Stage 14.12, apps/api/src/orders/capture.ts);
//   mismatch   money was captured, but not the order's total: it is recorded with the provider's amount, so
//              the order goes to review with its stock still held, never confirmed (capture.ts's own rule);
//   rejected   another order's or another payment's money, or not INR: never applied to this order, kept
//              for staff and reconciliation;
//   not_captured nothing to apply yet.
// A provider that cannot be asked is not a verdict: the error is passed on so the inbox retries later.
import { PaymentAdapterError, type PaymentAdapter } from "@chaanavya/contracts/integrations/payment-gateway"
import type { ProviderPaymentEventV1 } from "@chaanavya/contracts/modules/payment"
import type { Db } from "../db/client.ts"
import type { CaptureInput } from "../orders/capture.ts"

type Attempt = { id: string; orderId: string; providerOrderId: string; amountPaise: number }

export type CaptureVerdict =
  | { kind: "verified"; attempt: Attempt; providerPaymentId: string; capturedAmountPaise: number }
  | { kind: "mismatch"; attempt: Attempt; providerPaymentId: string; capturedAmountPaise: number; reason: "amount" }
  | { kind: "rejected"; attempt: Attempt; reason: "order" | "payment" | "currency" | "order_total" }
  | { kind: "not_captured"; attempt: Attempt; status: string }
  | { kind: "no_attempt" }

export async function verifyCapture(db: Db, adapter: PaymentAdapter, event: Pick<ProviderPaymentEventV1, "provider" | "providerOrderId" | "providerPaymentId">): Promise<CaptureVerdict> {
  if (event.provider !== adapter.provider) return { kind: "no_attempt" }
  const row = await db.paymentAttempt.findFirst({
    where: { provider: adapter.provider, providerOrderId: event.providerOrderId },
    select: { id: true, orderId: true, providerOrderId: true, amountPaise: true, currency: true, order: { select: { grandTotalPaise: true, currency: true } } },
  })
  if (!row?.providerOrderId) return { kind: "no_attempt" }
  const attempt: Attempt = { id: row.id, orderId: row.orderId, providerOrderId: row.providerOrderId, amountPaise: Number(row.amountPaise) }
  // The attempt was made for the order's total in INR (Stage 14.03); a difference here is never paid over.
  if (row.amountPaise !== row.order.grandTotalPaise || row.currency !== "INR" || row.order.currency !== "INR") return { kind: "rejected", attempt, reason: "order_total" }

  let found
  try {
    found = await adapter.lookupPayment({ providerOrderId: attempt.providerOrderId, providerPaymentId: event.providerPaymentId })
  } catch (error) {
    if (error instanceof PaymentAdapterError && error.kind === "not_found") return { kind: "not_captured", attempt, status: "not_found" }
    throw error
  }
  if (found.providerOrderId !== attempt.providerOrderId) return { kind: "rejected", attempt, reason: "order" }
  if (event.providerPaymentId !== null && found.providerPaymentId !== event.providerPaymentId) return { kind: "rejected", attempt, reason: "payment" }
  if (!found.capturedAmount || !found.providerPaymentId) return { kind: "not_captured", attempt, status: found.status }
  if (found.reportedCurrency !== "INR") return { kind: "rejected", attempt, reason: "currency" }
  const captured = found.capturedAmount.amountPaise
  if (captured !== attempt.amountPaise) return { kind: "mismatch", attempt, providerPaymentId: found.providerPaymentId, capturedAmountPaise: captured, reason: "amount" }
  return { kind: "verified", attempt, providerPaymentId: found.providerPaymentId, capturedAmountPaise: captured }
}

/**
 * What the capture bridge is given for a verdict that recorded money: the provider's own amount, in INR.
 * Null for any other verdict: nothing may be applied.
 */
export function captureInputFor(verdict: CaptureVerdict, event: Pick<ProviderPaymentEventV1, "provider" | "eventId" | "fingerprint">, correlationId: string): CaptureInput | null {
  if (verdict.kind !== "verified" && verdict.kind !== "mismatch") return null
  return {
    paymentAttemptId: verdict.attempt.id,
    event: { provider: event.provider, eventId: event.eventId, fingerprint: event.fingerprint },
    capturedAmountPaise: verdict.capturedAmountPaise,
    currency: "INR",
    providerPaymentId: verdict.providerPaymentId,
    correlationId,
  }
}
