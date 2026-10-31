// The payment webhook inbox (Stage 14.10). Every verified provider event is kept once, by provider and event
// id, before the provider is told it was received; working on it happens afterwards, from the inbox.
//
// Receive  a new event is stored as received. The same event again (same id, same body fingerprint) is a
//          duplicate and changes nothing. The same id with a different body is a conflict: it is never
//          stored over the first, and the first conflict is noted for staff. Each delivery is answered
//          only after its row is committed; if storing fails, the provider gets an error and delivers
//          again, which is safe because storing is idempotent.
// Process  a worker claims received events (and events whose earlier claim lapsed) with a claim id and a
//          lease, without waiting on rows another worker holds. The handler runs once per claim; only the
//          claim's holder can finish it. Done is final. A failure is retried later with growing waits, then
//          given up as failed after MAX_ATTEMPTS, for staff. A handler must itself be safe to run again for
//          the same event (a lapsed claim reruns it), as applyCapture is (apps/api/src/orders/capture.ts).
// Not here what an event does to a payment or an order (Stage 14.11 onwards).
import type { ProviderPaymentEventV1 } from "@chaanavya/contracts/modules/payment"
import type { Db } from "../db/client.ts"

/** Tries before an event is given up for staff, and the wait after each failed try. */
export const MAX_ATTEMPTS = 5
export const RETRY_WAITS_MS = Object.freeze([60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000])
/** How long a claim lasts before another worker may take the event over. */
export const CLAIM_LEASE_MS = 2 * 60_000
const ERROR_TEXT = 300

export type InboxReceipt = { outcome: "stored" | "duplicate" | "conflict"; id: string }

/** Keeps a verified event once. */
export async function recordWebhookEvent(db: Db, event: ProviderPaymentEventV1): Promise<InboxReceipt> {
  const inserted = await db.$queryRaw<{ id: string }[]>`
    INSERT INTO "payment_webhook_inbox" ("id", "provider", "event_id", "fingerprint", "type", "provider_order_id", "provider_payment_id", "provider_refund_id", "amount_paise", "currency", "occurred_at")
    VALUES (gen_random_uuid(), ${event.provider}::"PaymentProvider", ${event.eventId}, ${event.fingerprint}, ${event.type}, ${event.providerOrderId}, ${event.providerPaymentId}, ${event.providerRefundId}, ${event.amount.amountPaise}, ${event.amount.currency}, ${new Date(event.occurredAt)})
    ON CONFLICT ("provider", "event_id") DO NOTHING
    RETURNING "id"`
  if (inserted.length === 1) return { outcome: "stored", id: inserted[0].id }
  const earlier = await db.paymentWebhookInbox.findUniqueOrThrow({ where: { provider_eventId: { provider: event.provider, eventId: event.eventId } }, select: { id: true, fingerprint: true } })
  if (earlier.fingerprint === event.fingerprint) return { outcome: "duplicate", id: earlier.id }
  // Never stored over the first; the first conflict is noted for staff, once.
  await db.paymentWebhookInbox.updateMany({ where: { id: earlier.id, conflictAt: null }, data: { conflictAt: new Date() } })
  return { outcome: "conflict", id: earlier.id }
}

export type InboxEvent = ProviderPaymentEventV1 & { inboxId: string; claimId: string; attempt: number }

type ClaimedRow = { id: string; claim_id: string; attempts: number; provider: string; event_id: string; fingerprint: string; type: string; provider_order_id: string; provider_payment_id: string | null; provider_refund_id: string | null; amount_paise: bigint; currency: string; occurred_at: Date }

/** Claims up to `limit` events that are due, oldest first, skipping rows another worker holds. */
/** `types` limits a worker to the events it has a handler for; others stay received for the stage that handles them. */
export type ClaimOptions = { limit?: number; now?: Date; leaseMs?: number; types?: readonly ProviderPaymentEventV1["type"][] }

export async function claimWebhookEvents(db: Db, { limit = 20, now, leaseMs = CLAIM_LEASE_MS, types }: ClaimOptions = {}): Promise<InboxEvent[]> {
  const only = types ? [...types] : null
  // Without a given time, the database's own clock: the clock that stamped when each event is due (a host clock
  // even a few milliseconds behind would see a just-stored event as not due yet).
  const at = now ?? null
  const rows = await db.$queryRaw<ClaimedRow[]>`
    UPDATE "payment_webhook_inbox" AS i
    SET "status" = 'processing', "claim_id" = gen_random_uuid(), "locked_until" = COALESCE(${at}::timestamptz, clock_timestamp()) + make_interval(secs => ${leaseMs / 1000}), "attempts" = i."attempts" + 1
    WHERE i."id" IN (
      SELECT "id" FROM "payment_webhook_inbox"
      WHERE (("status" = 'received' AND "next_attempt_at" <= COALESCE(${at}::timestamptz, clock_timestamp())) OR ("status" = 'processing' AND "locked_until" <= COALESCE(${at}::timestamptz, clock_timestamp())))
        AND (${only}::text[] IS NULL OR "type" = ANY(${only}::text[]))
      ORDER BY "received_at", "id"
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING i."id", i."claim_id", i."attempts", i."provider"::text AS provider, i."event_id", i."fingerprint", i."type", i."provider_order_id", i."provider_payment_id", i."provider_refund_id", i."amount_paise", i."currency", i."occurred_at"`
  return rows.map(r => ({
    inboxId: r.id,
    claimId: r.claim_id,
    attempt: r.attempts,
    provider: r.provider as ProviderPaymentEventV1["provider"],
    eventId: r.event_id,
    fingerprint: r.fingerprint,
    type: r.type as ProviderPaymentEventV1["type"],
    providerOrderId: r.provider_order_id,
    providerPaymentId: r.provider_payment_id,
    providerRefundId: r.provider_refund_id,
    amount: { amountPaise: Number(r.amount_paise), currency: "INR" } as ProviderPaymentEventV1["amount"],
    occurredAt: r.occurred_at.toISOString() as ProviderPaymentEventV1["occurredAt"],
  }))
}

/** Marks a claimed event done. True only for the claim's own holder, once. */
export async function completeWebhookEvent(db: Db, event: Pick<InboxEvent, "inboxId" | "claimId">, now = new Date()): Promise<boolean> {
  const done = await db.paymentWebhookInbox.updateMany({
    where: { id: event.inboxId, claimId: event.claimId, status: "processing" },
    data: { status: "processed", processedAt: now, claimId: null, lockedUntil: null, lastError: null },
  })
  return done.count === 1
}

/** Records a failed try: retried after a growing wait, or given up as failed after MAX_ATTEMPTS. */
export async function failWebhookEvent(db: Db, event: Pick<InboxEvent, "inboxId" | "claimId" | "attempt">, error: string, now = new Date()): Promise<"retry" | "failed" | "not_held"> {
  const giveUp = event.attempt >= MAX_ATTEMPTS
  const wait = RETRY_WAITS_MS[Math.min(event.attempt - 1, RETRY_WAITS_MS.length - 1)]
  const updated = await db.paymentWebhookInbox.updateMany({
    where: { id: event.inboxId, claimId: event.claimId, status: "processing" },
    data: { status: giveUp ? "failed" : "received", claimId: null, lockedUntil: null, lastError: error.slice(0, ERROR_TEXT), ...(giveUp ? {} : { nextAttemptAt: new Date(now.getTime() + wait) }) },
  })
  return updated.count === 0 ? "not_held" : giveUp ? "failed" : "retry"
}

export type InboxHandler = (event: InboxEvent) => Promise<void>

/** One pass of the worker: claims due events and runs the handler once per claim. */
export async function processWebhookInbox(db: Db, handler: InboxHandler, options: ClaimOptions = {}) {
  const claimed = await claimWebhookEvents(db, options)
  const result = { processed: 0, retrying: 0, failed: 0, lost: 0 }
  for (const event of claimed) {
    try {
      await handler(event)
    } catch (error) {
      const outcome = await failWebhookEvent(db, event, error instanceof Error ? error.message : "the handler failed", options.now)
      if (outcome === "retry") result.retrying += 1
      else if (outcome === "failed") result.failed += 1
      else result.lost += 1
      continue
    }
    if (await completeWebhookEvent(db, event, options.now)) result.processed += 1
    else result.lost += 1
  }
  return result
}
