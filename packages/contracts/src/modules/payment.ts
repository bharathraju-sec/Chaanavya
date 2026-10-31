import type { Actor, ContractVersion, IdempotencyKey, IsoDateTime, OrderId, PaymentAttemptId, PaymentProviderName, RefundId, Result } from "./common.ts"
import type { MoneyPaise } from "./money.ts"
import type { CheckoutSessionV1 } from "../integrations/payment-gateway.ts"
import type { PaymentStatus, RefundStatus } from "./state-machines.ts"

// Payment module. Authority for whether money moved: the payment provider. Our records mirror it
// through verified webhooks and server-side lookups, never through browser redirects alone.

export type PaymentAttemptV1 = {
  version: ContractVersion
  id: PaymentAttemptId
  orderId: OrderId
  provider: PaymentProviderName
  mode: "test" | "live"
  /** Amount sent to the provider, copied from the order total on the server. */
  amount: MoneyPaise
  providerOrderId: string
  providerPaymentId: string | null
  status: PaymentStatus
  capturedAmount: MoneyPaise | null
  createdAt: IsoDateTime
  updatedAt: IsoDateTime
}

/**
 * What the browser needs to continue to the provider's checkout: open it on our page (embedded) or go to
 * the provider's page (redirect), as the adapter says (Stage 14.01). Public values only, never secrets.
 */
export type PaymentSessionV1 = {
  attemptId: PaymentAttemptId
  provider: PaymentProviderName
  providerOrderId: string
  amount: MoneyPaise
  next: CheckoutSessionV1["next"]
}

/** Read-only view on an order. Derived from attempts and refunds; not a second status field. */
export type PaymentSummaryV1 = {
  latestAttemptStatus: PaymentStatus | null
  captured: MoneyPaise
  refunded: MoneyPaise
}

export type RefundV1 = {
  version: ContractVersion
  id: RefundId
  paymentAttemptId: PaymentAttemptId
  amount: MoneyPaise
  status: RefundStatus
  reason: string
  requestedBy: Actor
  providerRefundId: string | null
  idempotencyKey: IdempotencyKey
  createdAt: IsoDateTime
}

/** Normalized, verified provider event, built by the payment adapter after its signature checks; the same shape for every provider. */
export type ProviderPaymentEventV1 = {
  provider: PaymentProviderName
  eventId: string
  /** Hash of the verified raw body, for duplicate versus conflict detection. */
  fingerprint: string
  type: "payment.authorized" | "payment.captured" | "payment.failed" | "refund.processed" | "refund.failed"
  providerOrderId: string
  providerPaymentId: string | null
  providerRefundId: string | null
  amount: MoneyPaise
  occurredAt: IsoDateTime
}

export interface PaymentService {
  startAttempt(orderId: OrderId, key: IdempotencyKey): Promise<Result<PaymentSessionV1>>
  /** Applies a verified event once (state-machines.ts `classifyProviderEvent` semantics). */
  recordProviderEvent(event: ProviderPaymentEventV1): Promise<Result<{ outcome: "applied" | "duplicate" | "conflict" | "ignored" }>>
  /** Asks the provider for the truth when the outcome is unknown (pending_reconciliation). */
  reconcile(attemptId: PaymentAttemptId): Promise<Result<PaymentAttemptV1>>
  requestRefund(actor: Actor, attemptId: PaymentAttemptId, amount: MoneyPaise, reason: string, key: IdempotencyKey): Promise<Result<RefundV1>>
}
