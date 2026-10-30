// Unpaid order expiry (Stage 13.09). Every minute: each pending order placed from a quote whose payment
// window has ended is cancelled and its stock released, on its own transaction, so one bad row cannot
// block the others. Cancelling is idempotent (compare-and-set on the order and the hold, ledger keys per
// hold line), so a retried or overlapping run, or a shopper cancelling at the same moment, never
// releases twice. An order whose payment is still in flight is left for its outcome. See
// apps/api/src/orders/cancel.ts.
import type { Db, Tx } from "@chaanavya/api/db/client"
import type { CancelOutcome, CancelReason } from "@chaanavya/api/orders/cancel"
import type { Job, JobResult } from "../runner.ts"

export const ORDER_EXPIRY_BATCH = 200

type Cancel = (tx: Tx, orderId: string, input: { reason: CancelReason; actor: { kind: "system"; id: null }; correlationId: string; now?: Date }) => Promise<CancelOutcome>

/** `clock` is for tests: the job asks it for the time instead of the system clock. */
export function orderExpiryJob(db: Db, cancel: Cancel, { clock = () => new Date() }: { clock?: () => Date } = {}): Job {
  return {
    name: "order-expiry",
    lockKey: 7_013,
    everyMs: 60 * 1000,
    async run(): Promise<JobResult> {
      const now = clock()
      const due = await db.order.findMany({
        where: { status: "pending_payment", payableUntil: { lte: now }, quoteRef: { not: null } },
        orderBy: { payableUntil: "asc" },
        take: ORDER_EXPIRY_BATCH,
        select: { id: true },
      })
      const result: JobResult = { cancelled: 0, awaiting: 0, failed: 0 }
      for (const { id } of due) {
        try {
          const outcome = await db.$transaction(tx => cancel(tx, id, { reason: "payment_window_ended", actor: { kind: "system", id: null }, correlationId: `worker:order-expiry:${id}`, now }), { maxWait: 10_000, timeout: 15_000 })
          if (outcome === "cancelled") result.cancelled++
          if (outcome === "awaiting_payment_outcome") result.awaiting++
        } catch {
          result.failed++
        }
      }
      return result
    },
  }
}
