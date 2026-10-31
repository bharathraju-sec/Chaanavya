// Payment-status reconciliation (Stage 14.14). Every minute: asks the payment provider about attempts whose
// outcome we do not know, at most a batch a run, each backing off between checks, and settles them through
// the checked payment code. A missing webhook is caught here. With payments off (no payment key) it does
// nothing. See apps/api/src/payments/reconcile.ts.
import type { Db } from "@chaanavya/api/db/client"
import type { reconcilePayments } from "@chaanavya/api/payments/reconcile"
import type { Job, JobResult } from "../runner.ts"

type Reconcile = typeof reconcilePayments
type PaymentAdapter = Parameters<Reconcile>[1]

/** `clock` is for tests: the job asks it for the time instead of the system clock. */
export function paymentReconciliationJob(db: Db, reconcile: Reconcile, adapter: PaymentAdapter | null, { clock = () => new Date() }: { clock?: () => Date } = {}): Job {
  return {
    name: "payment-reconciliation",
    lockKey: 7_016,
    everyMs: 60 * 1000,
    async run(): Promise<JobResult> {
      if (!adapter) return { skipped: 1 }
      return { ...(await reconcile(db, adapter, { now: clock() })) }
    },
  }
}
