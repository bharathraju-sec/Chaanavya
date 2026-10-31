// Payment webhook processing (Stage 14.12). Every 15 seconds: the captured-payment events waiting in the inbox
// (apps/api/src/payments/inbox.ts) are claimed and run through the capture handler
// (apps/api/src/payments/capture-handler.ts), which confirms each paid order exactly once. Each event is its own
// claim and its own transactions, so one bad event cannot block the others; a failure is retried by the inbox
// with growing waits. With payments off (no payment key) the job does nothing.
import type { Db } from "@chaanavya/api/db/client"
import type { InboxHandler, processWebhookInbox } from "@chaanavya/api/payments/inbox"
import type { Job, JobResult } from "../runner.ts"

/** Each event may ask Razorpay once (up to its 15-second budget), so a batch stays well inside the job's run. */
export const PAYMENT_INBOX_BATCH = 10

type Process = typeof processWebhookInbox
type EventTypes = NonNullable<NonNullable<Parameters<Process>[2]>["types"]>

export function paymentInboxJob(db: Db, process: Process, handler: InboxHandler | null, types: EventTypes): Job {
  return {
    name: "payment-inbox",
    lockKey: 7_015,
    everyMs: 15 * 1000,
    async run(): Promise<JobResult> {
      if (!handler) return { skipped: 1 }
      return process(db, handler, { limit: PAYMENT_INBOX_BATCH, types })
    },
  }
}
