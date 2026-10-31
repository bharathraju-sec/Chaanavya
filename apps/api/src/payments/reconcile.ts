// Payment-status reconciliation (Stage 14.14). Webhooks can be lost (Razorpay gives up after its retries, our
// host was down, the address was wrong), so the payment module does not rely on them: this job asks Razorpay
// directly about every attempt whose outcome we do not know, and settles it through the same checked code a
// webhook would reach.
//
// Asked about  attempts being reconciled (pending_reconciliation, e.g. a payment window that ended with the
//              checkout open), and open checkouts (created or authorized) that have heard nothing for
//              QUIET_MS: a buyer may have paid and the webhook gone missing.
// Settled      a capture Razorpay holds is checked (verify-capture.ts) and applied by the capture bridge
//              (orders/capture.ts) under a lookup event id, so a webhook for the same payment, earlier or later,
//              never applies twice. Once the window has ended, only failed tries close the attempt `failed`,
//              no payment closes it `expired` (close-attempt.ts), and the order expiry job then cancels the
//              order and releases its stock. Money authorized or in progress is left, and asked about again.
// Limits       at most RECONCILE_BATCH attempts a run; each attempt waits CHECK_WAITS_MS between checks; a
//              provider that cannot answer stops the run (no point asking it twenty more times). The last
//              recoverable error is kept on the attempt's record for staff. Stuck orders also stay visible as
//              Stage 13.14 recovery cases.
import { PaymentAdapterError, type PaymentAdapter } from "@chaanavya/contracts/integrations/payment-gateway"
import type { Db } from "../db/client.ts"
import { applyCapture } from "../orders/capture.ts"
import { closeOpenAttempt } from "./close-attempt.ts"
import { captureInputFor, verifyCapture } from "./verify-capture.ts"

export const RECONCILE_BATCH = 20
/** An open checkout that has heard nothing for this long is asked about. */
export const QUIET_MS = 10 * 60_000
/** The wait after each check, in order; the last repeats. */
export const CHECK_WAITS_MS = Object.freeze([2 * 60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000, 6 * 60 * 60_000])
const ERROR_TEXT = 300

export type CheckOutcome = "captured_applied" | "capture_rejected" | "closed_failed" | "closed_expired" | "still_open" | "in_flight" | "provider_unavailable" | "provider_error"
export type ReconcilePaymentsResult = { checked: number; applied: number; closed: number; waiting: number; errors: number; stopped: number }

type Due = { id: string; status: string; provider_order_id: string | null; payable_until: Date | null; checks: number | null }

const waitAfter = (checks: number) => CHECK_WAITS_MS[Math.min(checks - 1, CHECK_WAITS_MS.length - 1)]

/** Counts the check and sets the next one. Safe when two runs record the same attempt at once. */
async function record(db: Db, attemptId: string, outcome: CheckOutcome, error: string | null, now: Date) {
  await db.$executeRaw`INSERT INTO "payment_reconciliation" ("attempt_id") VALUES (${attemptId}::uuid) ON CONFLICT ("attempt_id") DO NOTHING`
  const [{ checks }] = await db.$queryRaw<{ checks: number }[]>`
    UPDATE "payment_reconciliation" SET "checks" = "checks" + 1, "last_checked_at" = ${now}, "last_outcome" = ${outcome}, "last_error" = ${error?.slice(0, ERROR_TEXT) ?? null}
    WHERE "attempt_id" = ${attemptId}::uuid RETURNING "checks"`
  await db.paymentReconciliation.update({ where: { attemptId }, data: { nextCheckAt: new Date(now.getTime() + waitAfter(checks)) } })
}

/** One attempt: what Razorpay says, and what that settles. */
async function check(db: Db, adapter: PaymentAdapter, a: Due, now: Date): Promise<CheckOutcome> {
  const correlationId = `reconcile:${a.id}`
  const windowEnded = a.status === "pending_reconciliation" || (a.payable_until !== null && a.payable_until.getTime() <= now.getTime())
  const close = async () => {
    const closed = await closeOpenAttempt(db, adapter, a.id, { reason: "payment_window_ended", correlationId })
    return closed === "failed" ? "closed_failed" : closed === "expired" ? "closed_expired" : closed === "money_in_flight" ? "in_flight" : "still_open"
  }
  if (!a.provider_order_id) return windowEnded ? close() : "still_open"

  let found
  try {
    found = await adapter.lookupPayment({ providerOrderId: a.provider_order_id, providerPaymentId: null })
  } catch (error) {
    if (!(error instanceof PaymentAdapterError && error.kind === "not_found")) throw error
    found = null
  }
  if (found?.capturedAmount && found.providerPaymentId) {
    // A capture whose webhook never came: settled exactly as the webhook would have been.
    const event = { provider: adapter.provider, eventId: `lookup:${found.providerPaymentId}`, fingerprint: `lookup:${found.providerPaymentId}:${found.capturedAmount.amountPaise}` }
    const verdict = await verifyCapture(db, adapter, { provider: adapter.provider, providerOrderId: a.provider_order_id, providerPaymentId: found.providerPaymentId })
    const input = captureInputFor(verdict, event, correlationId)
    if (!input) {
      const already = await db.auditEvent.findFirst({ where: { action: "payment.capture_rejected", correlationId }, select: { id: true } })
      if (!already) await db.auditEvent.create({ data: { action: "payment.capture_rejected", actorKind: "system", actorId: null, entityType: "payment_attempt", entityId: a.id, reason: verdict.kind === "rejected" ? verdict.reason : verdict.kind, after: { providerPaymentId: found.providerPaymentId }, correlationId } })
      return "capture_rejected"
    }
    await applyCapture(db, input)
    return "captured_applied"
  }
  if (found && found.status !== "failed") return "in_flight"
  // Only failed tries, or nothing at all: the buyer may still pay until the window ends.
  return windowEnded ? close() : "still_open"
}

/** One pass of the job. Safe to run again at any moment; overlapping runs are kept apart by the job's lock. */
export async function reconcilePayments(db: Db, adapter: PaymentAdapter, { now = new Date(), limit = RECONCILE_BATCH }: { now?: Date; limit?: number } = {}): Promise<ReconcilePaymentsResult> {
  const quietSince = new Date(now.getTime() - QUIET_MS)
  const due = await db.$queryRaw<Due[]>`
    SELECT a."id", a."status"::text AS status, a."provider_order_id", o."payable_until", r."checks"
    FROM "payment_attempt" a
    JOIN "order" o ON o."id" = a."order_id"
    LEFT JOIN "payment_reconciliation" r ON r."attempt_id" = a."id"
    WHERE a."provider" = ${adapter.provider}::"PaymentProvider" AND a."mode" = ${adapter.mode}::"PaymentMode"
      AND (a."status" = 'pending_reconciliation' OR (a."status" IN ('created', 'authorized') AND a."provider_order_id" IS NOT NULL AND a."created_at" <= ${quietSince}))
      AND (r."attempt_id" IS NULL OR r."next_check_at" <= ${now})
    ORDER BY COALESCE(r."next_check_at", a."created_at"), a."id"
    LIMIT ${limit}`

  const result: ReconcilePaymentsResult = { checked: 0, applied: 0, closed: 0, waiting: 0, errors: 0, stopped: 0 }
  for (const a of due) {
    result.checked += 1
    let outcome: CheckOutcome
    let error: string | null = null
    try {
      outcome = await check(db, adapter, a, now)
    } catch (e) {
      const unknown = e instanceof PaymentAdapterError && e.outcomeUnknown
      outcome = unknown ? "provider_unavailable" : "provider_error"
      error = e instanceof Error ? e.message : "the check failed"
    }
    await record(db, a.id, outcome, error, now)
    if (outcome === "captured_applied") result.applied += 1
    else if (outcome === "closed_failed" || outcome === "closed_expired") result.closed += 1
    else if (outcome === "provider_unavailable" || outcome === "provider_error") result.errors += 1
    else result.waiting += 1
    // The provider is not answering: stop here and let the waits space out the next tries.
    if (outcome === "provider_unavailable") {
      result.stopped = 1
      break
    }
  }
  return result
}
