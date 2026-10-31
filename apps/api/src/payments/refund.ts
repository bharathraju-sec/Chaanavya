// Refunds (Stage 14.16), sandbox only. Staff with refund permission refund part or all of a captured payment;
// nothing on the storefront can start one.
//
// Who      the route needs refunds.approve and a two-factor staff session (http/access.ts); the amount must
//          be within the approver's limit (auth/policies.ts: ADMIN up to ₹5,000, OWNER without limit).
// How much never more than is still refundable: the captured amount Razorpay itself reports for the payment,
//          less what Razorpay has already refunded and every refund we have under way or done. Whole paise,
//          INR, at least ₹1. Nothing the browser says about the payment is used.
// Once     the refund row is written, under the attempt's lock, before Razorpay is asked, so simultaneous or
//          repeated requests can never refund past the paid amount; the same Idempotency-Key returns the same
//          refund, and a request whose outcome was lost is resumed by retrying with that key (the adapter
//          finds Razorpay's refund by our key before making another).
// Status   Razorpay's refund id and status are recorded. A processed refund succeeds and moves the payment to
//          partially_refunded or refunded; a pending one waits for Razorpay's refund.processed or
//          refund.failed webhook (refundEventHandler below); a refund Razorpay refused fails. The order itself
//          is not changed here.
import { randomUUID } from "node:crypto"
import { PaymentAdapterError, type PaymentAdapter, type ProviderRefundV1 } from "@chaanavya/contracts/integrations/payment-gateway"
import type { IdempotencyKey } from "@chaanavya/contracts/modules/common"
import type { MoneyPaise } from "@chaanavya/contracts/modules/money"
import { planTransition, REFUND_MACHINE, type RefundStatus } from "@chaanavya/contracts/modules/state-machines"
import { ApiError, UUID } from "../admin/api.ts"
import { recordAdminEvent } from "../audit/catalogue.ts"
import { canApproveRefund, refundApprovalLimitPaise } from "../auth/policies.ts"
import type { StaffActor } from "../auth/session.ts"
import type { Db, Tx } from "../db/client.ts"
import { transitionPayment } from "../db/transitions.ts"
import type { InboxHandler } from "./inbox.ts"

const KEY = /^[A-Za-z0-9_-]{8,100}$/
const REFUNDABLE_PAYMENTS = ["captured", "partially_refunded"]
/** Refunds that count against the refundable balance: under way or done. */
const COUNTED: RefundStatus[] = ["requested", "processing", "succeeded"]

export type RefundRequest = { amountPaise: unknown; reason: unknown }
export type RefundView = { id: string; paymentAttemptId: string; amount: { amountPaise: number; currency: "INR" }; status: RefundStatus; providerRefundId: string | null; reason: string; createdAt: string }

const view = (r: { id: string; paymentAttemptId: string; amountPaise: bigint; status: RefundStatus; providerRefundId: string | null; reason: string; createdAt: Date }): RefundView => ({
  id: r.id,
  paymentAttemptId: r.paymentAttemptId,
  amount: { amountPaise: Number(r.amountPaise), currency: "INR" },
  status: r.status,
  providerRefundId: r.providerRefundId,
  reason: r.reason,
  createdAt: r.createdAt.toISOString(),
})

export function parseRefundRequest(body: Record<string, unknown>): { amountPaise: number; reason: string } {
  const problems: Record<string, string> = {}
  const amount = body.amountPaise
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 100) problems.amountPaise = "invalid"
  const reason = typeof body.reason === "string" ? body.reason.trim() : ""
  if (reason.length < 3 || reason.length > 500) problems.reason = "required"
  for (const name of Object.keys(body)) if (name !== "amountPaise" && name !== "reason") problems[name] = "unexpected"
  if (Object.keys(problems).length > 0) throw new ApiError(400, "invalid_request", "check the highlighted fields", problems)
  return { amountPaise: amount as number, reason }
}

/** Moves a refund through the refund machine (requested -> processing -> succeeded or failed), compare-and-set. */
async function moveRefund(tx: Tx, refundId: string, from: RefundStatus, to: RefundStatus, source: "staff" | "provider", correlationId: string, actor: { kind: "staff" | "provider"; id: string }) {
  const plan = planTransition(REFUND_MACHINE, from, to, { source, staffApproved: source === "staff" })
  if (plan.kind === "noop") return "noop" as const
  if (plan.kind === "rejected") throw new ApiError(409, "conflict", "this refund cannot move that way", { refund: plan.reason })
  const { count } = await tx.refund.updateMany({ where: { id: refundId, status: from }, data: { status: to } })
  if (count === 1) await tx.auditEvent.create({ data: { action: "refund.transition", actorKind: actor.kind, actorId: actor.id, entityType: "refund", entityId: refundId, reason: plan.precondition, before: { status: from }, after: { status: to }, correlationId } })
  return count === 1 ? ("applied" as const) : ("noop" as const)
}

/** Once a refund succeeded: the payment is partly or fully refunded, by the provider's word. */
async function settleSucceeded(tx: Tx, attemptId: string, provider: string, correlationId: string) {
  const attempt = await tx.paymentAttempt.findUniqueOrThrow({ where: { id: attemptId }, select: { status: true, capturedAmountPaise: true } })
  const done = await tx.refund.aggregate({ where: { paymentAttemptId: attemptId, status: "succeeded" }, _sum: { amountPaise: true } })
  const full = (done._sum.amountPaise ?? 0n) >= (attempt.capturedAmountPaise ?? 0n)
  const to = full ? "refunded" : "partially_refunded"
  if (attempt.status === to || !REFUNDABLE_PAYMENTS.includes(attempt.status)) return
  await transitionPayment(tx, { paymentAttemptId: attemptId, from: attempt.status as "captured", to, facts: { refundFullyCovered: full }, actor: { kind: "provider", id: provider }, correlationId })
}

/** Records Razorpay's answer for a refund under way: its id once, and its status. */
async function recordProviderAnswer(db: Db, refundId: string, attemptId: string, answer: ProviderRefundV1, provider: string, correlationId: string) {
  await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "payment_attempt" WHERE id = ${attemptId}::uuid FOR UPDATE`
    if (answer.providerRefundId) await tx.refund.updateMany({ where: { id: refundId, providerRefundId: null }, data: { providerRefundId: answer.providerRefundId } })
    const now = await tx.refund.findUniqueOrThrow({ where: { id: refundId }, select: { status: true, providerRefundId: true } })
    if (answer.providerRefundId && now.providerRefundId !== answer.providerRefundId) throw new ApiError(409, "conflict", "this refund already has another provider reference")
    if (now.status !== "processing") return
    const actor = { kind: "provider" as const, id: provider }
    if (answer.status === "processed") {
      await moveRefund(tx, refundId, "processing", "succeeded", "provider", correlationId, actor)
      await settleSucceeded(tx, attemptId, provider, correlationId)
    } else if (answer.status === "failed") {
      await moveRefund(tx, refundId, "processing", "failed", "provider", correlationId, actor)
    }
  })
}

/** A staff refund of a captured payment. Safe to repeat with the same key and to race. */
export async function requestRefund(db: Db, adapter: PaymentAdapter, staff: StaffActor, attemptId: string, key: string | undefined, input: { amountPaise: number; reason: string }, correlationId: string): Promise<{ refund: RefundView; created: boolean }> {
  if (!UUID.test(attemptId)) throw new ApiError(404, "not_found", "not found")
  if (key === undefined) throw new ApiError(428, "precondition_required", "an Idempotency-Key is required")
  if (!KEY.test(key)) throw new ApiError(400, "invalid_request", "Idempotency-Key must be 8 to 100 letters, digits, - or _", { "Idempotency-Key": "invalid" })
  if (!canApproveRefund(staff.capabilities, input.amountPaise)) {
    throw new ApiError(403, "forbidden", "this refund is above your approval limit", { amountPaise: "over_limit", limitPaise: String(refundApprovalLimitPaise(staff.capabilities) ?? "") })
  }
  const stored = `refund:${attemptId}:${key}`

  const attempt = await db.paymentAttempt.findUnique({ where: { id: attemptId }, select: { id: true, provider: true, mode: true, status: true, providerOrderId: true, providerPaymentId: true, capturedAmountPaise: true, currency: true } })
  if (!attempt) throw new ApiError(404, "not_found", "not found")
  const same = await db.refund.findUnique({ where: { idempotencyKey: stored } })
  if (!same) {
    if (attempt.provider !== adapter.provider || attempt.mode !== adapter.mode) throw new ApiError(409, "conflict", "this payment is not with the payment provider in use")
    if (!REFUNDABLE_PAYMENTS.includes(attempt.status) || !attempt.providerPaymentId || !attempt.providerOrderId || attempt.capturedAmountPaise === null) {
      throw new ApiError(409, "conflict", "only a captured payment can be refunded", { payment: attempt.status })
    }
  }

  // Razorpay's own record of the payment: what was captured and what it has refunded already.
  let paid
  try {
    paid = same ? null : await adapter.lookupPayment({ providerOrderId: attempt.providerOrderId!, providerPaymentId: attempt.providerPaymentId! })
  } catch (error) {
    if (error instanceof PaymentAdapterError) throw new ApiError(502, "unavailable", "the payment provider could not be checked; try again")
    throw error
  }
  if (paid && (paid.providerPaymentId !== attempt.providerPaymentId || paid.reportedCurrency !== "INR" || paid.capturedAmount?.amountPaise !== Number(attempt.capturedAmountPaise))) {
    throw new ApiError(409, "conflict", "the payment provider's record of this payment does not match ours; staff must check it", { payment: "provider_mismatch" })
  }

  const { refund, created } = await db.$transaction(
    async tx => {
      // One refund decision at a time per payment: concurrent requests queue here.
      await tx.$queryRaw`SELECT id FROM "payment_attempt" WHERE id = ${attemptId}::uuid FOR UPDATE`
      const existing = await tx.refund.findUnique({ where: { idempotencyKey: stored } })
      if (existing) {
        if (Number(existing.amountPaise) !== input.amountPaise) throw new ApiError(409, "conflict", "this Idempotency-Key was used for another amount", { amountPaise: "key_reused" })
        return { refund: existing, created: false }
      }
      const counted = await tx.refund.aggregate({ where: { paymentAttemptId: attemptId, status: { in: COUNTED } }, _sum: { amountPaise: true } })
      const ours = Number(counted._sum.amountPaise ?? 0n)
      const theirs = paid!.refundedAmount.amountPaise
      const refundable = Number(attempt.capturedAmountPaise) - Math.max(ours, theirs)
      if (input.amountPaise > refundable) throw new ApiError(409, "conflict", "the refund is more than is left to refund", { amountPaise: "over_refundable", refundablePaise: String(Math.max(0, refundable)) })

      const row = await tx.refund.create({
        data: { id: randomUUID(), paymentAttemptId: attemptId, amountPaise: BigInt(input.amountPaise), currency: "INR", status: "requested", reason: input.reason, requestedByKind: "staff", requestedById: staff.userId, idempotencyKey: stored },
      })
      await moveRefund(tx, row.id, "requested", "processing", "staff", correlationId, { kind: "staff", id: staff.userId })
      await recordAdminEvent(tx, { action: "refund.approved", actor: { kind: "staff", id: staff.userId }, entity: { type: "refund", id: row.id }, reason: input.reason, correlationId, after: { amountPaise: input.amountPaise } })
      return { refund: await tx.refund.findUniqueOrThrow({ where: { id: row.id } }), created: true }
    },
    { maxWait: 10_000, timeout: 15_000 },
  )

  // Ask Razorpay only for a refund still waiting for its answer (a new one, or one whose answer was lost).
  if (refund.status === "processing" && !refund.providerRefundId) {
    let answer: ProviderRefundV1
    try {
      answer = await adapter.refund({ providerOrderId: attempt.providerOrderId!, providerPaymentId: attempt.providerPaymentId!, amount: { amountPaise: Number(refund.amountPaise), currency: "INR" } as MoneyPaise, reason: refund.reason, key: refund.idempotencyKey as IdempotencyKey })
    } catch (error) {
      if (error instanceof PaymentAdapterError && error.kind === "rejected") {
        await db.$transaction(tx => moveRefund(tx, refund.id, "processing", "failed", "provider", correlationId, { kind: "provider", id: adapter.provider }))
        throw new ApiError(409, "conflict", "the payment provider refused the refund", { refund: "provider_rejected" })
      }
      if (error instanceof PaymentAdapterError) throw new ApiError(502, "unavailable", "the refund's outcome is not known yet; retry with the same Idempotency-Key")
      throw error
    }
    await recordProviderAnswer(db, refund.id, attemptId, answer, adapter.provider, correlationId)
  }
  return { refund: view(await db.refund.findUniqueOrThrow({ where: { id: refund.id } })), created }
}

/**
 * The inbox handler for refund.processed and refund.failed (Stage 14.16): Razorpay is asked about the refund
 * itself, and only a refund of ours, for its own payment, moves.
 */
export function refundEventHandler(db: Db, adapter: PaymentAdapter): InboxHandler {
  return async event => {
    if (event.type !== "refund.processed" && event.type !== "refund.failed") throw new Error(`no refund handling for ${event.type}`)
    const ours = event.providerRefundId ? await db.refund.findUnique({ where: { providerRefundId: event.providerRefundId }, select: { id: true, paymentAttemptId: true, amountPaise: true } }) : null
    if (!ours) return
    const answer = await adapter.lookupRefund({ providerRefundId: event.providerRefundId, key: "" as IdempotencyKey })
    if (answer.providerPaymentId !== event.providerPaymentId || answer.amount.amountPaise !== Number(ours.amountPaise)) return
    await recordProviderAnswer(db, ours.id, ours.paymentAttemptId, answer, adapter.provider, `inbox:${event.inboxId}`)
  }
}

export const REFUND_EVENT_TYPES = ["refund.processed", "refund.failed"] as const
