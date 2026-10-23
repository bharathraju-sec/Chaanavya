import type { IdempotencyKey, NotificationProviderName } from "../modules/common.ts"

// Port for transactional and marketing messages (Stage 18). Messages are sent from a durable
// outbox after the state change commits, so a provider outage delays mail but never loses an
// order. Interface only; no provider is chosen yet.

export type MessageCategory = "transactional" | "marketing"

export type TemplateId =
  | "order_confirmed"
  | "payment_pending"
  | "payment_failed"
  | "order_dispatched"
  | "order_delivered"
  | "order_cancelled"
  | "refund_processed"
  | "return_update"
  | "welcome_offer"

export type OutboundMessageV1 = {
  channel: NotificationProviderName
  category: MessageCategory
  templateId: TemplateId
  /** Email address or E.164 phone number. Never logged in full. */
  to: string
  data: Record<string, string | number>
  /** One logical message per key and channel: replays send nothing new (S18-001). */
  key: IdempotencyKey
}

export interface NotificationSender {
  readonly channel: NotificationProviderName
  /** Marketing sends require recorded consent; the caller checks it before calling. */
  send(message: OutboundMessageV1): Promise<{ status: "accepted"; providerMessageId: string } | { status: "rejected"; reason: string } | { status: "retryable"; reason: string }>
}
