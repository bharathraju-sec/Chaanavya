// The captured-payment allocation bridge (Stage 13.10). When a payment provider authoritatively reports
// a capture (a verified webhook or a provider lookup; verifying the event is Stage 14's adapter), the
// order's held stock becomes allocated and the order is confirmed, exactly once.
//
// Event    the event is recorded once by provider and event id (provider_event): the same id and body
//          again is a duplicate and changes nothing; the same id with a different body is a conflict
//          and is never applied. A new event for a payment already captured (gateways send more than
//          one) applies nothing new.
// Payment  the event must come from a payment provider, and from the attempt's own provider. The
//          captured amount is recorded, then the attempt moves to captured (transitionPayment).
// Stock    the hold is settled by Stage 09's own settleReservation: the captured amount must equal the
//          order's grand total in INR, and the held units then move reserved -> allocated through the
//          Stage 09 ledger, one movement per line under a key per hold and line, so a replay or a race
//          can never allocate twice. A captured amount that differs sends the order to needs_review and
//          keeps the stock held for staff; nothing is allocated or released.
// Order    with the stock allocated, the order moves pending_payment -> confirmed (transitionOrder), by
//          the payment provider.
// Late     (Stage 13.11) a capture whose hold was already released (the hold expired first), or whose
//          order is no longer pending (confirmed by another payment, cancelled), is a late payment. Its
//          stock may already be sold to someone else, so nothing is re-reserved, allocated or promised:
//          a pending order goes to needs_review, a closed one stays as it is, and a payment.late_capture
//          audit event records the exception for staff to reallocate by hand or refund. The order
//          machine confirms a reviewed order only with stock allocated again.
// Locks    order, then payment, then hold: the same order as cancellation (13.09), so a capture racing
//          the expiry jobs can't deadlock, and the hold is locked before it is decided, so the Stage 09
//          expiry job either releases it first (a late payment) or finds it allocated.
// Origins  every move names the provider and the request (Stage 13.08). Fulfilment never moves here.
import { actorClassOf, type ProviderEventRef } from "@chaanavya/contracts/modules/state-machines"
import { ApiError } from "../admin/api.ts"
import type { Db, Tx } from "../db/client.ts"
import { transitionOrder, transitionPayment } from "../db/transitions.ts"
import { settleReservation } from "../inventory/reservations.ts"

export type CaptureInput = {
  paymentAttemptId: string
  event: ProviderEventRef
  capturedAmountPaise: number
  currency: string
  providerPaymentId?: string | null
  correlationId: string
}

/** `late`: the hold was released first; `exception`: the order was no longer pending (both left for staff). */
export type CaptureOutcome = "confirmed" | "needs_review" | "late" | "exception" | "already_applied" | "duplicate" | "conflict"

const PAYABLE = ["created", "authorized", "pending_reconciliation"]

/** Records the event once and decides it; returns null when the event is new. */
async function seen(tx: Tx, event: ProviderEventRef, summary: object): Promise<CaptureOutcome | null> {
  const inserted = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO "provider_event" ("id", "provider", "event_id", "fingerprint", "type", "summary")
    VALUES (gen_random_uuid(), ${event.provider}, ${event.eventId}, ${event.fingerprint}, 'payment.captured', ${JSON.stringify(summary)}::jsonb)
    ON CONFLICT ("provider", "event_id") DO NOTHING
    RETURNING "id"`
  if (inserted.length === 1) return null
  const earlier = await tx.providerEvent.findUniqueOrThrow({ where: { provider_eventId: { provider: event.provider, eventId: event.eventId } }, select: { fingerprint: true } })
  return earlier.fingerprint === event.fingerprint ? "duplicate" : "conflict"
}

async function settle(tx: Tx, event: ProviderEventRef, outcome: CaptureOutcome) {
  const stored = outcome === "confirmed" || outcome === "needs_review" || outcome === "late" || outcome === "exception" ? "applied" : outcome === "already_applied" ? "duplicate" : outcome
  await tx.providerEvent.update({ where: { provider_eventId: { provider: event.provider, eventId: event.eventId } }, data: { outcome: stored, processedAt: new Date() } })
}

/** Applies one authoritative capture. Safe to call any number of times, from any number of places at once. */
export async function applyCapture(db: Db, input: CaptureInput): Promise<{ outcome: CaptureOutcome; orderId: string }> {
  const actor = { kind: "provider" as const, id: input.event.provider }
  if (actorClassOf(actor) !== "payment_provider") throw new ApiError(403, "forbidden", "only a payment provider can report a capture")
  if (!Number.isSafeInteger(input.capturedAmountPaise) || input.capturedAmountPaise < 0) throw new ApiError(400, "invalid_request", "the captured amount must be whole paise", { capturedAmountPaise: "invalid" })

  return db.$transaction(
    async tx => {
      // The order first, then the attempt: concurrent events for one payment, and a cancellation, queue here.
      // NO KEY UPDATE, so the Stage 09 expiry job's order-event rows (a foreign key to the order) can still
      // be written while it holds the reservation: otherwise the two would deadlock.
      const [ref] = await tx.$queryRaw<{ order_id: string }[]>`SELECT order_id FROM "payment_attempt" WHERE id = ${input.paymentAttemptId}::uuid`
      if (!ref) throw new ApiError(404, "not_found", "not found")
      await tx.$queryRaw`SELECT id FROM "order" WHERE id = ${ref.order_id}::uuid FOR NO KEY UPDATE`
      const [attempt] = await tx.$queryRaw<{ id: string; order_id: string; provider: string; status: string }[]>`SELECT id, order_id, provider::text AS provider, status::text AS status FROM "payment_attempt" WHERE id = ${input.paymentAttemptId}::uuid FOR UPDATE`
      if (!attempt) throw new ApiError(404, "not_found", "not found")
      if (attempt.provider !== input.event.provider) throw new ApiError(409, "conflict", "the event is not from this payment's provider", { provider: "mismatch" })

      const earlier = await seen(tx, input.event, { paymentAttemptId: attempt.id, capturedAmountPaise: input.capturedAmountPaise, currency: input.currency })
      if (earlier) return { outcome: earlier, orderId: attempt.order_id }

      let outcome: CaptureOutcome
      if (attempt.status === "captured") {
        outcome = "already_applied"
      } else if (PAYABLE.includes(attempt.status)) {
        await tx.paymentAttempt.update({ where: { id: attempt.id }, data: { capturedAmountPaise: BigInt(input.capturedAmountPaise), currency: input.currency, ...(input.providerPaymentId ? { providerPaymentId: input.providerPaymentId } : {}) } })
        await transitionPayment(tx, { paymentAttemptId: attempt.id, from: attempt.status as "created", to: "captured", facts: {}, actor, correlationId: input.correlationId })
        outcome = await allocateAndConfirm(tx, { orderId: attempt.order_id, paymentAttemptId: attempt.id, capturedAmountPaise: input.capturedAmountPaise }, actor, input.correlationId)
      } else {
        // A failed, expired or refunded attempt cannot be captured: keep it for reconciliation (13.14).
        await settle(tx, input.event, "conflict")
        return { outcome: "conflict" as const, orderId: attempt.order_id }
      }
      await settle(tx, input.event, outcome)
      return { outcome, orderId: attempt.order_id }
    },
    { maxWait: 10_000, timeout: 15_000 },
  )
}

type Captured = { orderId: string; paymentAttemptId: string; capturedAmountPaise: number }
type ProviderActor = { kind: "provider"; id: string }

/** The Stage 09 settlement of the order's hold, then the order's confirmation; or a late payment. */
async function allocateAndConfirm(tx: Tx, c: Captured, actor: ProviderActor, correlationId: string): Promise<CaptureOutcome> {
  const order = await tx.order.findUniqueOrThrow({ where: { id: c.orderId }, select: { status: true } })
  if (order.status !== "pending_payment") {
    // Confirmed by another payment, under review, or closed: never allocate a second time.
    await lateCapture(tx, c, actor, correlationId, `order_${order.status}`, { orderStatus: order.status })
    return "exception"
  }
  const [hold] = await tx.$queryRaw<{ id: string; status: string }[]>`SELECT id, status::text AS status FROM "inventory_reservation" WHERE order_id = ${c.orderId}::uuid FOR UPDATE`
  if (hold?.status === "active") {
    const settled = await settleReservation(tx, hold.id, correlationId)
    // A captured amount that differs: settleReservation sent the order to review and kept the stock held.
    if (settled === "needs_review") return "needs_review"
    if (settled !== "allocated") throw new ApiError(409, "conflict", "the stock hold could not be settled", { reservation: settled })
    await transitionOrder(tx, { orderId: c.orderId, from: "pending_payment", to: "confirmed", facts: { paymentStatus: "captured", amountMatches: true, reservationStatus: "allocated" }, actor, correlationId })
    return "confirmed"
  }
  if (hold && hold.status !== "released") throw new ApiError(409, "conflict", "the stock hold is in an unexpected state", { reservation: hold.status })
  // The hold was released before the money arrived (or the order never held stock): no stock is held for it.
  await transitionOrder(tx, { orderId: c.orderId, from: "pending_payment", to: "needs_review", facts: { paymentStatus: "captured", reservationStatus: "released" }, actor, correlationId })
  await lateCapture(tx, c, actor, correlationId, "hold_released", { holdStatus: hold?.status ?? null })
  return "late"
}

/** The exception record staff work from: which payment, how much, and why it was not applied to stock. */
async function lateCapture(tx: Tx, c: Captured, actor: ProviderActor, correlationId: string, reason: string, found: Record<string, string | null>) {
  await tx.auditEvent.create({
    data: { action: "payment.late_capture", actorKind: actor.kind, actorId: actor.id, entityType: "order", entityId: c.orderId, reason, after: { paymentAttemptId: c.paymentAttemptId, capturedAmountPaise: c.capturedAmountPaise, ...found }, correlationId },
  })
}
