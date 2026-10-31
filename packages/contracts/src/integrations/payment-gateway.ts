import type { IdempotencyKey, IsoDateTime, PaymentAttemptId, PaymentProviderName } from "../modules/common.ts"
import type { MoneyPaise } from "../modules/money.ts"
import type { ProviderPaymentEventV1 } from "../modules/payment.ts"

// Payment adapter contract (Stage 14.01): the one port between the payment module and a payment provider.
// Razorpay is the first adapter (sandbox only until merchant KYC, banking and tax approvals are confirmed);
// PhonePe or another provider must fit without changing the payment module. Rules every adapter keeps:
//   - provider-neutral vocabulary: no provider field names, signature formats or status words cross this
//     line; each adapter maps its provider's own words to the types below, and anything it cannot map is
//     "unknown", never a guess;
//   - money is whole paise from the order on the server, never from the browser;
//   - an adapter reports what the provider says; it never moves an order, payment or stock itself;
//   - hosted checkout only: no card number, CVV or expiry ever passes through our servers;
//   - a timeout or an unreadable answer means the outcome is unknown, never that the payment failed.
// Only the payment module calls it, on the server. UI components never import this folder or a provider
// SDK (enforced by eslint.config.mjs).

export type GatewayMode = "test" | "live"

/** What a provider can do, so the payment module adapts without knowing who the provider is. */
export type PaymentAdapterCapabilities = {
  /** "embedded": the browser opens the provider's checkout on our page; "redirect": it leaves for the provider's page. */
  checkout: "embedded" | "redirect"
  /** The provider authorizes first and captures separately (true), or captures at once (false). */
  separateCapture: boolean
  partialRefunds: boolean
}

/** A payment's state as its provider reports it, in neutral words. */
export type ProviderPaymentStatus = "created" | "pending" | "authorized" | "captured" | "failed" | "refunded" | "partially_refunded" | "unknown"

export type CreateCheckoutInput = {
  attemptId: PaymentAttemptId
  /** Our order number, shown to the buyer by the provider and used to find the payment again. */
  reference: string
  amount: MoneyPaise
  /** Where a redirect checkout sends the buyer back; ignored by embedded checkouts. */
  returnUrl: string
  key: IdempotencyKey
  /** The provider reference already stored for this attempt: rebuild its session without opening another (Stage 14.04). */
  existingProviderOrderId?: string | null
}

export type CheckoutSessionV1 = {
  /** The provider's reference for this checkout (stored on the payment attempt). */
  providerOrderId: string
  expiresAt: IsoDateTime | null
  /** What the browser needs to continue: public values only, never a secret. */
  next: { kind: "embedded"; publicParams: Record<string, string> } | { kind: "redirect"; url: string }
}

/** What the browser brought back from the provider's checkout: a hint only, checked against what we stored. */
export type CheckoutReturnInput = { storedProviderOrderId: string; returned: Readonly<Record<string, string>> }
export type CheckoutReturnResult = { verified: false } | { verified: true; providerPaymentId: string | null }

/** Find a payment by our stored checkout reference (and the provider's payment id, once known). */
export type PaymentLookupInput = { providerOrderId: string; providerPaymentId: string | null }

export type ProviderPaymentV1 = {
  providerOrderId: string
  providerPaymentId: string | null
  status: ProviderPaymentStatus
  amount: MoneyPaise
  capturedAmount: MoneyPaise | null
  refundedAmount: MoneyPaise
  capturedAt: IsoDateTime | null
  /**
   * The currency code exactly as the provider reported it (Stage 14.11). `amount` is always typed INR; this
   * says whether the provider agrees. Anything but "INR" never matches an order. Absent: not reported.
   */
  reportedCurrency?: string
}

/** Whether the money was captured: the one question reconciliation asks (Stage 13.09 to 13.14). */
export type CaptureStatusV1 = {
  state: "captured" | "not_captured" | "failed" | "unknown"
  providerPaymentId: string | null
  capturedAmount: MoneyPaise | null
  checkedAt: IsoDateTime
}

export type RefundInput = { providerOrderId: string; providerPaymentId: string; amount: MoneyPaise; reason: string; key: IdempotencyKey }
export type RefundLookupInput = { providerRefundId: string | null; key: IdempotencyKey }

export type ProviderRefundV1 = {
  providerRefundId: string | null
  providerPaymentId: string
  amount: MoneyPaise
  status: "pending" | "processed" | "failed" | "unknown"
}

/** The provider's request as received. `rawBytes`, when given, are the exact bytes the signature covers (Stage 14.09). */
export type WebhookInput = { rawBody: string; rawBytes?: Uint8Array; headers: Readonly<Record<string, string>> }
/** A verified event, `null` for a verified event the payment module does not act on, or not valid. */
export type WebhookResult = { valid: false } | { valid: true; event: ProviderPaymentEventV1 | null }

export interface PaymentAdapter {
  readonly provider: PaymentProviderName
  /** An adapter built with test keys refuses to start in a live environment (Stage 03/14). */
  readonly mode: GatewayMode
  readonly capabilities: PaymentAdapterCapabilities
  /** Opens a checkout for an amount taken from the order on the server. The same key returns the same checkout. */
  createCheckout(input: CreateCheckoutInput): Promise<CheckoutSessionV1>
  /** Checks the browser's return against the stored checkout reference. Never moves a payment on its own. */
  verifyReturn(input: CheckoutReturnInput): Promise<CheckoutReturnResult>
  /** Verifies the provider's signature over the raw body, then normalizes the event. */
  parseWebhook(input: WebhookInput): Promise<WebhookResult>
  lookupPayment(input: PaymentLookupInput): Promise<ProviderPaymentV1>
  captureStatus(input: PaymentLookupInput): Promise<CaptureStatusV1>
  /** The same key never refunds twice. */
  refund(input: RefundInput): Promise<ProviderRefundV1>
  lookupRefund(input: RefundLookupInput): Promise<ProviderRefundV1>
}

/** @deprecated The earlier name of the port (Stage 02); kept so existing imports keep compiling. */
export type PaymentGateway = PaymentAdapter

export const PAYMENT_ADAPTER_METHODS = ["createCheckout", "verifyReturn", "parseWebhook", "lookupPayment", "captureStatus", "refund", "lookupRefund"] as const

/**
 * Why a provider call did not give an answer. `unavailable`, `timeout` and `invalid_response` leave the
 * outcome unknown: the caller records it for reconciliation and never treats it as a failed payment.
 */
export type PaymentAdapterErrorKind = "unavailable" | "timeout" | "invalid_response" | "rejected" | "not_found" | "misconfigured"

const OUTCOME_UNKNOWN: readonly PaymentAdapterErrorKind[] = ["unavailable", "timeout", "invalid_response"]

export class PaymentAdapterError extends Error {
  readonly provider: PaymentProviderName
  readonly kind: PaymentAdapterErrorKind
  constructor(provider: PaymentProviderName, kind: PaymentAdapterErrorKind, message: string) {
    super(message)
    this.name = "PaymentAdapterError"
    this.provider = provider
    this.kind = kind
  }
  /** The provider may have acted: ask it again later rather than assume either way. */
  get outcomeUnknown() {
    return OUTCOME_UNKNOWN.includes(this.kind)
  }
  /** Worth retrying with the same idempotency key. */
  get retryable() {
    return this.outcomeUnknown
  }
}
