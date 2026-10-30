// Order recovery reconciliation (Stage 13.14). Every five minutes: finds stuck orders and stock holds and
// opens, refreshes or clears a recovery case for each, for a person to look at. It reads orders, payments
// and holds and never changes them, and never decides how a payment ended. Each case is written on its own
// transaction; one open case per order and kind, so an overlapping run never opens a second. See
// apps/api/src/orders/recovery.ts.
import type { Db } from "@chaanavya/api/db/client"
import type { ReconcileResult } from "@chaanavya/api/orders/recovery"
import type { Job, JobResult } from "../runner.ts"

type Reconcile = (db: Db, now?: Date) => Promise<ReconcileResult>

/** `clock` is for tests: the job asks it for the time instead of the system clock. */
export function orderReconciliationJob(db: Db, reconcile: Reconcile, { clock = () => new Date() }: { clock?: () => Date } = {}): Job {
  return {
    name: "order-reconciliation",
    lockKey: 7_014,
    everyMs: 5 * 60 * 1000,
    async run(): Promise<JobResult> {
      return { ...(await reconcile(db, clock())) }
    },
  }
}
