import type { IdempotencyKey, IsoDateTime, PaymentAttemptId, PaymentProviderName } from "../modules/common.ts"
import type { MoneyPaise } from "../modules/money.ts"
import type { ProviderPaymentEventV1 } from "../modules/payment.ts"

// Port for payment providers (Razorpay first, in test mode; PhonePe later). Only the payment
// module calls it, on the server. UI components never import this folder or a provider SDK
// (enforced by eslint.config.mjs). This is an interface, not a working gateway.

export type GatewayMode = "test" | "live"

export type ProviderPaymentStatus = "created" | "authorized" | "captured" | "failed" | "refunded" | "unknown"

export type ProviderPaymentV1 = {
  providerPaymentId: string
  providerOrderId: string
  status: ProviderPaymentStatus
  amount: MoneyPaise
  capturedAt: IsoDateTime | null
}

export type ProviderRefundV1 = { providerRefundId: string; providerPaymentId: string; amount: MoneyPaise; status: "pending" | "processed" | "failed" }

export interface PaymentGateway {
  readonly provider: PaymentProviderName
  /** A gateway built with test keys refuses to start in a live environment (Stage 03/14). */
  readonly mode: GatewayMode
  /** Amount comes from the order on the server; the browser never chooses it. */
  createSession(input: { attemptId: PaymentAttemptId; amount: MoneyPaise; receipt: string; key: IdempotencyKey }): Promise<{ providerOrderId: string; publicParams: Record<string, string> }>
  /** Checks the checkout signature against the provider order ID we stored, not one from the browser. */
  verifyCheckout(input: { storedProviderOrderId: string; providerPaymentId: string; signature: string }): Promise<{ verified: boolean }>
  /** Verifies the signature over the raw request body, then normalizes the event. */
  validateWebhook(input: { rawBody: string; headers: Record<string, string> }): Promise<{ valid: false } | { valid: true; event: ProviderPaymentEventV1 }>
  retrievePayment(providerPaymentId: string): Promise<ProviderPaymentV1>
  refundPayment(input: { providerPaymentId: string; amount: MoneyPaise; reason: string; key: IdempotencyKey }): Promise<ProviderRefundV1>
  retrieveRefund(providerRefundId: string): Promise<ProviderRefundV1>
}
