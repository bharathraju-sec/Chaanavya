// Cancelling an unpaid order (Stage 13.09): when its payment window ends (a worker job) or when its
// shopper cancels before paying. One transaction: the stock hold is released through the Stage 09
// reservation code, then the order moves pending_payment -> cancelled through the checked transition.
//
// Once     the hold's release is a compare-and-set on its status with one ledger movement per line under
//          a key per hold and line (Stage 09), and the order's cancellation is a compare-and-set too, so
//          a retried job, a repeated click, or a job and a shopper racing release the stock exactly once
//          and cancel the order exactly once. Every later attempt is a no-op.
// Payment  an order is cancelled only when no payment was started, or every attempt closed without a
//          capture (failed, expired). While any attempt is still open (created, authorized, being
//          reconciled) its outcome is unknown and the order is left pending, holding its stock: a
//          created attempt whose window has passed is marked pending_reconciliation (the machine's
//          system move), so the gateway is asked (Stage 13.14) before anything is released. A captured
//          payment is never cancelled here (13.10, 13.11).
// Origins  every move names its actor and request (Stage 13.08).
import type { Shopper } from "@chaanavya/contracts/modules/common"
import type { PlacedOrderV1 } from "@chaanavya/contracts/modules/order"
import type { GuardFacts, PaymentStatus } from "@chaanavya/contracts/modules/state-machines"
import { ApiError, UUID } from "../admin/api.ts"
import type { Db, Tx } from "../db/client.ts"
import type { ActorKind } from "../db/generated/enums.ts"
import { transitionOrder, transitionPayment } from "../db/transitions.ts"
import { transitionReservation } from "../inventory/reservations.ts"
import { ownerWhere, VIEW, view } from "./intent.ts"

export type CancelOutcome = "cancelled" | "awaiting_payment_outcome" | "noop"
export type CancelReason = "payment_window_ended" | "shopper_cancelled"

const OPEN: readonly PaymentStatus[] = ["created", "authorized", "pending_reconciliation"]
const CAPTURED: readonly PaymentStatus[] = ["captured", "partially_refunded", "refunded"]

/**
 * Cancels one unpaid order and releases its hold, in the caller's transaction. Returns what happened;
 * safe to call any number of times, from any number of places at once.
 */
export async function cancelUnpaidOrder(
  tx: Tx,
  orderId: string,
  input: { reason: CancelReason; actor: { kind: ActorKind; id: string | null }; correlationId: string; now?: Date },
): Promise<CancelOutcome> {
  const now = input.now ?? new Date()
  // The order row first: parallel cancellations of one order queue here, and the loser sees it cancelled.
  const [order] = await tx.$queryRaw<{ status: string; payable_until: Date | null }[]>`SELECT status, payable_until FROM "order" WHERE id = ${orderId}::uuid FOR UPDATE`
  if (!order || order.status !== "pending_payment") return "noop"
  if (input.reason === "payment_window_ended" && (!order.payable_until || order.payable_until.getTime() > now.getTime())) return "noop"

  const attempts = await tx.paymentAttempt.findMany({ where: { orderId }, orderBy: { createdAt: "desc" }, select: { id: true, status: true } })
  if (attempts.some(a => CAPTURED.includes(a.status as PaymentStatus))) return "noop"
  const open = attempts.filter(a => OPEN.includes(a.status as PaymentStatus))
  if (open.length > 0) {
    // Outcome unknown: ask the gateway first. A created attempt past the window becomes "being reconciled".
    if (input.reason === "payment_window_ended") {
      for (const a of open.filter(a => a.status === "created")) {
        await transitionPayment(tx, { paymentAttemptId: a.id, from: "created", to: "pending_reconciliation", facts: {}, actor: { kind: "system", id: null }, correlationId: input.correlationId })
      }
    }
    return "awaiting_payment_outcome"
  }

  const paymentStarted = attempts.length > 0
  const latest = attempts[0]?.status as PaymentStatus | undefined
  const hold = await tx.inventoryReservation.findUnique({ where: { orderId }, select: { id: true, status: true, expiresAt: true } })
  const facts: GuardFacts = {
    paymentStarted,
    paymentStatus: latest,
    cancelRequested: input.reason === "shopper_cancelled",
    reservationExpired: hold ? hold.expiresAt.getTime() <= now.getTime() : undefined,
  }
  if (hold?.status === "active") {
    const released = await transitionReservation(tx, hold.id, "released", facts, input.reason === "shopper_cancelled" ? "shopper cancelled before paying" : "payment window ended without payment", input.correlationId)
    if (released === "rejected") throw new ApiError(409, "conflict", "the stock hold cannot be released", { reservation: "rejected" })
  }
  const held = hold ? (await tx.inventoryReservation.findUniqueOrThrow({ where: { id: hold.id }, select: { status: true } })).status : undefined
  if (hold && held !== "released") return "noop"
  await transitionOrder(tx, { orderId, from: "pending_payment", to: "cancelled", facts: { ...facts, reservationStatus: "released" }, actor: input.actor, correlationId: input.correlationId })
  return "cancelled"
}

/**
 * The shopper cancels their own unpaid order. Another shopper's order, an unknown id or a malformed id
 * is the same 404; an order that is no longer pending cannot be cancelled here (409).
 */
export async function shopperCancelsOrder(db: Db, owner: Shopper | null, orderId: string, correlationId: string): Promise<{ outcome: CancelOutcome; order: PlacedOrderV1 }> {
  if (!owner || !UUID.test(orderId)) throw new ApiError(404, "not_found", "not found")
  const actor = owner.kind === "customer" ? { kind: "customer" as const, id: owner.customerId } : { kind: "guest" as const, id: null }
  return db.$transaction(
    async tx => {
      const mine = await tx.order.findFirst({ where: { id: orderId, ...ownerWhere(owner) }, select: { id: true, status: true, quoteRef: true } })
      if (!mine || mine.quoteRef === null) throw new ApiError(404, "not_found", "not found")
      if (mine.status !== "pending_payment" && mine.status !== "cancelled") throw new ApiError(409, "conflict", "this order can no longer be cancelled here", { order: mine.status })
      const outcome = await cancelUnpaidOrder(tx, orderId, { reason: "shopper_cancelled", actor, correlationId })
      const after = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: VIEW })
      return { outcome, order: view(after) }
    },
    { maxWait: 10_000, timeout: 15_000 },
  )
}
