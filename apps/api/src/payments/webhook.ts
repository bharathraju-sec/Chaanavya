// Receiving a payment provider's webhook (Stage 14.09). The provider calls us server to server, so there is
// no session or same-origin check (http/access.ts, @Access.webhook()); instead nothing is believed until the
// adapter has verified the provider's signature over the exact bytes received, then the event id and the
// event itself. Anything that does not verify is a 400 with one message, so a caller learns nothing about
// which check failed. The body, signature and secrets are never logged or returned.
//
// Each verified event we act on is kept once in the inbox (Stage 14.10, payments/inbox.ts) before it is
// acknowledged: a duplicate delivery changes nothing, and if storing fails the provider gets an error and
// delivers again. A verified event of a type we do not act on is acknowledged and not kept. Acting on an
// event happens later, from the inbox (14.11 onwards).
import type { PaymentAdapter } from "@chaanavya/contracts/integrations/payment-gateway"
import { ApiError, type RawBody } from "../admin/api.ts"
import type { Db } from "../db/client.ts"
import { recordWebhookEvent, type InboxReceipt } from "./inbox.ts"

/** Headers never given to the adapter: they are ours, not the provider's. */
const OURS = new Set(["cookie", "authorization", "x-chaanavya-internal-key"])

export type WebhookReceipt = { received: true; event: { type: string; eventId: string; inbox: InboxReceipt["outcome"] } | null }

export async function receiveWebhook(db: Db, adapter: PaymentAdapter, body: RawBody, rawHeaders: Readonly<Record<string, string | string[] | undefined>>): Promise<WebhookReceipt> {
  if (body.text === null || !body.bytes) throw new ApiError(413, "invalid_request", "request too large")
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(rawHeaders)) if (typeof value === "string" && !OURS.has(name.toLowerCase())) headers[name.toLowerCase()] = value
  const result = await adapter.parseWebhook({ rawBody: body.text, rawBytes: body.bytes, headers })
  if (!result.valid) throw new ApiError(400, "invalid_request", "the webhook could not be verified")
  if (!result.event) return { received: true, event: null }
  const stored = await recordWebhookEvent(db, result.event)
  return { received: true, event: { type: result.event.type, eventId: result.event.eventId, inbox: stored.outcome } }
}
