// Reservation expiry (Stage 09). Every minute: each active reservation past its expiry (or whose
// payment closed) is settled on its own transaction (savepoint per reservation), so one bad row
// cannot block the others, and a crash mid-run simply leaves the rest for the next run. Settling is
// idempotent (compare-and-set on the status, ledger keys per reservation line), so a retried or
// overlapping run never releases twice. See apps/api/src/inventory/reservations.ts.
import type { Db, Tx } from "@chaanavya/api/db/client"
import type { ExpiryOutcome } from "@chaanavya/api/inventory/reservations"
import type { Job, JobResult } from "../runner.ts"

export const EXPIRY_BATCH = 200

type Settle = (tx: Tx, reservationId: string, correlationId: string, now?: Date) => Promise<ExpiryOutcome>

export function reservationExpiryJob(db: Db, settle: Settle): Job {
  return {
    name: "reservation-expiry",
    lockKey: 7_004,
    everyMs: 60 * 1000,
    // The runner holds the job's lock in its own transaction; each reservation then gets its own.
    async run(): Promise<JobResult> {
      const now = new Date()
      const due = await db.inventoryReservation.findMany({
        where: { status: "active", OR: [{ expiresAt: { lte: now } }, { order: { status: "cancelled" } }, { order: { payments: { some: { status: { in: ["captured", "failed", "expired"] } } } } }] },
        orderBy: { expiresAt: "asc" },
        take: EXPIRY_BATCH,
        select: { id: true },
      })
      const result: JobResult = { released: 0, allocated: 0, held: 0, review: 0, failed: 0 }
      for (const { id } of due) {
        try {
          const outcome = await db.$transaction(tx => settle(tx, id, `worker:reservation-expiry:${id}`, now))
          if (outcome === "released") result.released++
          if (outcome === "allocated") result.allocated++
          if (outcome === "held_for_payment") result.held++
          if (outcome === "needs_review") result.review++
        } catch {
          result.failed++
        }
      }
      return result
    },
  }
}
