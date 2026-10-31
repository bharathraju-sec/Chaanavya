// A failed payment try (Stage 14.13). The inbox hands this handler each payment.failed event. Razorpay is asked
// about the payment itself; only a payment Razorpay holds as failed, for the Razorpay order we opened, is
// recorded, once per event, for staff (payment.try_failed). Nothing else changes: the attempt stays open, the
// stock stays held, and the buyer may try again on the same checkout (close-attempt.ts explains why). A payment
// Razorpay now shows as authorized or captured (a late success) is left to the capture flow.
import { PaymentAdapterError, type PaymentAdapter } from "@chaanavya/contracts/integrations/payment-gateway"
import type { Db } from "../db/client.ts"
import { noteForStaff } from "./capture-handler.ts"
import type { InboxHandler } from "./inbox.ts"

export function failureHandler(db: Db, adapter: PaymentAdapter): InboxHandler {
  return async event => {
    if (event.type !== "payment.failed") throw new Error(`no failure handling for ${event.type}`)
    const attempt = await db.paymentAttempt.findFirst({ where: { provider: adapter.provider, providerOrderId: event.providerOrderId }, select: { id: true, orderId: true } })
    if (!attempt) {
      await noteForStaff(db, event, "payment.failure_unmatched", "no_attempt", { type: "provider_order", id: event.providerOrderId }, { providerPaymentId: event.providerPaymentId })
      return
    }
    let found
    try {
      found = await adapter.lookupPayment({ providerOrderId: event.providerOrderId, providerPaymentId: event.providerPaymentId })
    } catch (error) {
      // Razorpay has no such payment: the event is not believed, and nothing is recorded.
      if (error instanceof PaymentAdapterError && error.kind === "not_found") return
      throw error
    }
    if (found.providerOrderId !== event.providerOrderId || found.status !== "failed") return
    await noteForStaff(db, event, "payment.try_failed", "provider_reports_failed", { type: "order", id: attempt.orderId }, { paymentAttemptId: attempt.id, providerPaymentId: found.providerPaymentId })
  }
}
