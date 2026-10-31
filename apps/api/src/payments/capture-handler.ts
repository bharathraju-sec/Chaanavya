// From a captured-payment webhook to a confirmed order (Stage 14.12). The inbox (payments/inbox.ts) hands this
// handler each payment.captured event, once per claim; the handler:
//   1. asks Razorpay what was really captured and checks it against the attempt and order (verify-capture.ts);
//   2. hands the capture bridge (orders/capture.ts) the provider's own amount, which in ONE transaction records
//      the event once (provider_event), captures the payment, allocates the held stock through the Stage 09
//      ledger, confirms the order and writes the order.paid outbox event.
//
// Crash   anywhere before that transaction commits, nothing has changed and the event is retried. After it
//         commits but before the inbox marks the event done, the claim lapses and the event runs again: the
//         bridge finds the event already recorded and changes nothing. A second event for the same payment
//         (Razorpay can send more than one) finds the payment already captured. So a crash or a replay can
//         never confirm an order, allocate its stock or announce it twice.
// Verdicts a payment Razorpay does not yet show as captured is retried (and given up for staff after the
//         inbox's last try); money for another order, another payment or another currency, and an event for
//         an order we never opened, are recorded once for staff and never applied.
import type { PaymentAdapter } from "@chaanavya/contracts/integrations/payment-gateway"
import type { Db } from "../db/client.ts"
import { applyCapture } from "../orders/capture.ts"
import type { InboxEvent, InboxHandler } from "./inbox.ts"
import { captureInputFor, verifyCapture } from "./verify-capture.ts"

/** The event types this handler acts on. */
export const CAPTURE_EVENT_TYPES = ["payment.captured"] as const

export class CaptureNotYetVisible extends Error {
  constructor(status: string) {
    super(`Razorpay does not show the payment as captured yet (${status})`)
    this.name = "CaptureNotYetVisible"
  }
}

/** One audit record per event and reason, however often the event is run. */
export async function noteForStaff(db: Db, event: InboxEvent, action: string, reason: string, entity: { type: string; id: string }, after: object) {
  const correlationId = `inbox:${event.inboxId}`
  const already = await db.auditEvent.findFirst({ where: { action, correlationId }, select: { id: true } })
  if (already) return
  await db.auditEvent.create({ data: { action, actorKind: "provider", actorId: event.provider, entityType: entity.type, entityId: entity.id, reason, after: { eventId: event.eventId, ...after }, correlationId } })
}

export function captureHandler(db: Db, adapter: PaymentAdapter): InboxHandler {
  return async event => {
    if (event.type !== "payment.captured") throw new Error(`no capture handling for ${event.type}`)
    // A provider that cannot be asked throws here: the inbox retries the event later.
    const verdict = await verifyCapture(db, adapter, event)
    if (verdict.kind === "not_captured") throw new CaptureNotYetVisible(verdict.status)
    if (verdict.kind === "no_attempt") {
      await noteForStaff(db, event, "payment.capture_unmatched", "no_attempt", { type: "provider_order", id: event.providerOrderId }, { providerPaymentId: event.providerPaymentId })
      return
    }
    if (verdict.kind === "rejected") {
      await noteForStaff(db, event, "payment.capture_rejected", verdict.reason, { type: "order", id: verdict.attempt.orderId }, { paymentAttemptId: verdict.attempt.id, providerPaymentId: event.providerPaymentId })
      return
    }
    const input = captureInputFor(verdict, event, `inbox:${event.inboxId}`)
    if (!input) throw new Error("a recorded capture had no input")
    await applyCapture(db, input)
  }
}

/**
 * The worker's handler for every payment event it takes from the inbox (Stage 14.13): captures confirm their
 * order once (above), failed tries are recorded and end nothing (failure-handler.ts), and refund events settle
 * our refunds (refund.ts, Stage 14.16).
 */
export const PAYMENT_EVENT_TYPES = ["payment.captured", "payment.failed", "refund.processed", "refund.failed"] as const

export function paymentEventsHandler(db: Db, adapter: PaymentAdapter, onFailed: InboxHandler, onRefund?: InboxHandler): InboxHandler {
  const onCaptured = captureHandler(db, adapter)
  return async event => {
    if (event.type === "payment.captured") return onCaptured(event)
    if (event.type === "payment.failed") return onFailed(event)
    if ((event.type === "refund.processed" || event.type === "refund.failed") && onRefund) return onRefund(event)
    throw new Error(`no handling for ${event.type}`)
  }
}
