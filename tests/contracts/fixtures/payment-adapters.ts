// Two in-memory payment adapters for CHV-S14-M01, shaped like two very different providers: one with an
// embedded checkout, separate capture and lower-case statuses (Razorpay-like), one with a redirect checkout,
// immediate capture and upper-case states (PhonePe-like). Neither talks to a network or holds a real key.
// Both must satisfy the provider-neutral PaymentAdapter contract unchanged (checked by `npm run typecheck`).
import { createHash, createHmac } from "node:crypto"
import type { IdempotencyKey, IsoDateTime, PaymentProviderName } from "../../../packages/contracts/src/modules/common.ts"
import type { MoneyPaise } from "../../../packages/contracts/src/modules/money.ts"
import type { ProviderPaymentEventV1 } from "../../../packages/contracts/src/modules/payment.ts"
import {
  PaymentAdapterError,
  type CaptureStatusV1,
  type PaymentLookupInput,
  type PaymentAdapter,
  type ProviderPaymentStatus,
  type ProviderPaymentV1,
  type ProviderRefundV1,
} from "../../../packages/contracts/src/integrations/payment-gateway.ts"

const now = () => new Date().toISOString() as IsoDateTime
const inr = (amountPaise: number): MoneyPaise => ({ amountPaise, currency: "INR" })
const sign = (secret: string, body: string) => createHmac("sha256", secret).update(body).digest("hex")

type Payment = { orderRef: string; paymentId: string | null; native: string; amount: number; captured: number | null; refunded: number }
type Refund = { refundId: string; paymentId: string; amount: number; native: string }

/** The shared fake provider: a store of checkouts, payments and refunds, plus the ability to fail on purpose. */
class FakeProvider {
  readonly checkouts = new Map<string, Payment>()
  readonly byKey = new Map<string, string>()
  readonly refunds = new Map<string, Refund>()
  failNext: PaymentAdapterError | null = null
  readonly provider: PaymentProviderName
  constructor(provider: PaymentProviderName) {
    this.provider = provider
  }
  guard() {
    const error = this.failNext
    this.failNext = null
    if (error) throw error
  }
  payment(orderRef: string) {
    const p = this.checkouts.get(orderRef)
    if (!p) throw new PaymentAdapterError(this.provider, "not_found", "no such checkout")
    return p
  }
}

function captureStatusOf(p: ProviderPaymentV1): CaptureStatusV1 {
  const state = p.status === "captured" || p.status === "refunded" || p.status === "partially_refunded" ? "captured" : p.status === "failed" ? "failed" : p.status === "unknown" ? "unknown" : "not_captured"
  return { state, providerPaymentId: p.providerPaymentId, capturedAmount: p.capturedAmount, checkedAt: now() }
}

// ---- Razorpay-like: embedded checkout, authorize then capture, lower-case statuses ----------------

const LOWER: Record<string, ProviderPaymentStatus> = { created: "created", authorized: "authorized", captured: "captured", failed: "failed", refunded: "refunded" }

export function embeddedAdapter(secret = "test-embedded-secret") {
  const fake = new FakeProvider("razorpay")
  const view = (p: Payment): ProviderPaymentV1 => ({
    providerOrderId: p.orderRef,
    providerPaymentId: p.paymentId,
    status: p.refunded > 0 && p.refunded < (p.captured ?? 0) ? "partially_refunded" : (LOWER[p.native] ?? "unknown"),
    amount: inr(p.amount),
    capturedAmount: p.captured === null ? null : inr(p.captured),
    refundedAmount: inr(p.refunded),
    capturedAt: p.captured === null ? null : now(),
  })
  const lookup = async ({ providerOrderId }: PaymentLookupInput): Promise<ProviderPaymentV1> => {
    fake.guard()
    return view(fake.payment(providerOrderId))
  }
  const adapter = {
    provider: "razorpay",
    mode: "test",
    capabilities: { checkout: "embedded", separateCapture: true, partialRefunds: true },
    async createCheckout(input) {
      fake.guard()
      const existing = fake.byKey.get(input.key)
      const orderRef = existing ?? `order_${fake.checkouts.size + 1}`
      if (!existing) {
        fake.byKey.set(input.key, orderRef)
        fake.checkouts.set(orderRef, { orderRef, paymentId: null, native: "created", amount: input.amount.amountPaise, captured: null, refunded: 0 })
      }
      return { providerOrderId: orderRef, expiresAt: null, next: { kind: "embedded", publicParams: { checkoutRef: orderRef, amount: String(fake.payment(orderRef).amount) } } }
    },
    async verifyReturn({ storedProviderOrderId, returned }) {
      const paymentId = returned.paymentRef ?? ""
      const ok = Boolean(paymentId) && returned.proof === sign(secret, `${storedProviderOrderId}|${paymentId}`)
      return ok ? { verified: true, providerPaymentId: paymentId } : { verified: false }
    },
    async parseWebhook({ rawBody, headers }) {
      if (headers["x-fake-signature"] !== sign(secret, rawBody)) return { valid: false }
      const body = JSON.parse(rawBody) as { id: string; event: string; order: string; payment: string; amount: number }
      const type = ({ "payment.captured": "payment.captured", "payment.failed": "payment.failed", "payment.authorized": "payment.authorized" } as const)[body.event]
      if (!type) return { valid: true, event: null }
      const event: ProviderPaymentEventV1 = { provider: "razorpay", eventId: body.id, fingerprint: `sha256:${createHash("sha256").update(rawBody).digest("hex")}`, type, providerOrderId: body.order, providerPaymentId: body.payment, providerRefundId: null, amount: inr(body.amount), occurredAt: now() }
      return { valid: true, event }
    },
    lookupPayment: lookup,
    async captureStatus(input) {
      return captureStatusOf(await lookup(input))
    },
    async refund(input) {
      fake.guard()
      const id = `refund_${input.key}`
      if (!fake.refunds.has(id)) {
        const p = fake.payment(input.providerOrderId)
        if ((p.captured ?? 0) - p.refunded < input.amount.amountPaise) throw new PaymentAdapterError("razorpay", "rejected", "refund exceeds captured amount")
        p.refunded += input.amount.amountPaise
        p.native = p.refunded === p.captured ? "refunded" : p.native
        fake.refunds.set(id, { refundId: id, paymentId: input.providerPaymentId, amount: input.amount.amountPaise, native: "processed" })
      }
      const r = fake.refunds.get(id)!
      return { providerRefundId: r.refundId, providerPaymentId: r.paymentId, amount: inr(r.amount), status: "processed" }
    },
    async lookupRefund({ providerRefundId, key }) {
      const r = fake.refunds.get(providerRefundId ?? `refund_${key}`)
      if (!r) throw new PaymentAdapterError("razorpay", "not_found", "no such refund")
      return { providerRefundId: r.refundId, providerPaymentId: r.paymentId, amount: inr(r.amount), status: r.native === "processed" ? "processed" : "unknown" } satisfies ProviderRefundV1
    },
  } satisfies PaymentAdapter
  const pay = (orderRef: string, native: "authorized" | "captured" | "failed" | "on_hold", captured: number | null = null) => {
    const p = fake.payment(orderRef)
    Object.assign(p, { paymentId: p.paymentId ?? `pay_${orderRef}`, native, captured })
    return p.paymentId!
  }
  return { adapter, fake, pay, sign: (body: string) => sign(secret, body), proof: (orderRef: string, paymentId: string) => sign(secret, `${orderRef}|${paymentId}`) }
}

// ---- PhonePe-like: redirect checkout, captured at once, upper-case states, its own reference ------

const UPPER: Record<string, ProviderPaymentStatus> = { PENDING: "pending", COMPLETED: "captured", FAILED: "failed" }

export function redirectAdapter(secret = "test-redirect-secret") {
  const fake = new FakeProvider("phonepe")
  const view = (p: Payment): ProviderPaymentV1 => ({
    providerOrderId: p.orderRef,
    providerPaymentId: p.paymentId,
    status: p.refunded > 0 ? (p.refunded === p.captured ? "refunded" : "partially_refunded") : (UPPER[p.native] ?? "unknown"),
    amount: inr(p.amount),
    capturedAmount: p.captured === null ? null : inr(p.captured),
    refundedAmount: inr(p.refunded),
    capturedAt: p.captured === null ? null : now(),
  })
  const lookup = async ({ providerOrderId }: PaymentLookupInput): Promise<ProviderPaymentV1> => {
    fake.guard()
    return view(fake.payment(providerOrderId))
  }
  const adapter = {
    provider: "phonepe",
    mode: "test",
    capabilities: { checkout: "redirect", separateCapture: false, partialRefunds: true },
    async createCheckout(input) {
      fake.guard()
      // This provider keys a checkout by the merchant's own transaction reference.
      const orderRef = fake.byKey.get(input.key) ?? `MT${input.reference.replace(/\W/g, "")}${fake.checkouts.size + 1}`
      if (!fake.byKey.has(input.key)) {
        fake.byKey.set(input.key, orderRef)
        fake.checkouts.set(orderRef, { orderRef, paymentId: null, native: "PENDING", amount: input.amount.amountPaise, captured: null, refunded: 0 })
      }
      return { providerOrderId: orderRef, expiresAt: null, next: { kind: "redirect", url: `https://sandbox.example.test/pay/${orderRef}?back=${encodeURIComponent(input.returnUrl)}` } }
    },
    // The return carries no proof here: the adapter asks the provider instead of trusting the browser.
    async verifyReturn({ storedProviderOrderId, returned }) {
      if (returned.transactionRef !== storedProviderOrderId) return { verified: false }
      const p = fake.checkouts.get(storedProviderOrderId)
      return p && p.native === "COMPLETED" ? { verified: true, providerPaymentId: p.paymentId } : { verified: false }
    },
    async parseWebhook({ rawBody, headers }) {
      if (headers["x-verify"] !== `${sign(secret, rawBody)}###1`) return { valid: false }
      const body = JSON.parse(rawBody) as { eventRef: string; state: string; merchantTransactionId: string; transactionId: string; amount: number }
      const type = ({ COMPLETED: "payment.captured", FAILED: "payment.failed" } as const)[body.state]
      if (!type) return { valid: true, event: null }
      const event: ProviderPaymentEventV1 = { provider: "phonepe", eventId: body.eventRef, fingerprint: `sha256:${createHash("sha256").update(rawBody).digest("hex")}`, type, providerOrderId: body.merchantTransactionId, providerPaymentId: body.transactionId, providerRefundId: null, amount: inr(body.amount), occurredAt: now() }
      return { valid: true, event }
    },
    lookupPayment: lookup,
    async captureStatus(input) {
      return captureStatusOf(await lookup(input))
    },
    async refund(input) {
      fake.guard()
      const id = `R${input.key}`
      if (!fake.refunds.has(id)) {
        const p = fake.payment(input.providerOrderId)
        if ((p.captured ?? 0) - p.refunded < input.amount.amountPaise) throw new PaymentAdapterError("phonepe", "rejected", "refund exceeds captured amount")
        p.refunded += input.amount.amountPaise
        fake.refunds.set(id, { refundId: id, paymentId: input.providerPaymentId, amount: input.amount.amountPaise, native: "PENDING" })
      }
      const r = fake.refunds.get(id)!
      return { providerRefundId: r.refundId, providerPaymentId: r.paymentId, amount: inr(r.amount), status: "pending" }
    },
    async lookupRefund({ providerRefundId, key }) {
      const r = fake.refunds.get(providerRefundId ?? `R${key}`)
      if (!r) throw new PaymentAdapterError("phonepe", "not_found", "no such refund")
      return { providerRefundId: r.refundId, providerPaymentId: r.paymentId, amount: inr(r.amount), status: r.native === "PENDING" ? "pending" : r.native === "COMPLETED" ? "processed" : "unknown" }
    },
  } satisfies PaymentAdapter
  const pay = (orderRef: string, native: "COMPLETED" | "FAILED" | "PENDING" | "INTERVENTION_REQUIRED") => {
    const p = fake.payment(orderRef)
    Object.assign(p, { paymentId: p.paymentId ?? `T${orderRef}`, native, captured: native === "COMPLETED" ? p.amount : null })
    return p.paymentId!
  }
  return { adapter, fake, pay, sign: (body: string) => `${sign(secret, body)}###1`, proof: () => "" }
}

export const keyOf = (value: string) => value as IdempotencyKey
