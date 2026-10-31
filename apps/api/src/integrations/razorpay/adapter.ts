// The Razorpay payment adapter (Stage 14), behind the provider-neutral PaymentAdapter contract
// (packages/contracts/src/integrations/payment-gateway.ts). Sandbox only until the legal gate opens: it is
// built from a RazorpayConfig, whose client refuses any call outside its mode (config.ts).
//
// createCheckout (Stage 14.04) opens a Razorpay order for the amount the payment module gives it, which the
// module takes from the saved order, never from the browser. Razorpay's answer is checked before it is
// believed: the order must exist, be "created", and ask for exactly that amount in INR; anything else is an
// invalid response and nothing is recorded. Retries and timeouts (Stage 14.05) are bounded and never open a
// second order for one attempt (RAZORPAY_RETRY below). Checkout returns (14.07, 14.08) and webhooks (14.09) are
// believed only once Razorpay's signature verifies. Payment lookups (14.11) and refunds (14.16) complete the contract.
import { createHash } from "node:crypto"
import type { IsoDateTime } from "@chaanavya/contracts/modules/common"
import type { MoneyPaise } from "@chaanavya/contracts/modules/money"
import type { ProviderPaymentEventV1 } from "@chaanavya/contracts/modules/payment"
import {
  PaymentAdapterError,
  type CaptureStatusV1,
  type CheckoutReturnInput,
  type CheckoutReturnResult,
  type CheckoutSessionV1,
  type CreateCheckoutInput,
  type PaymentAdapter,
  type PaymentLookupInput,
  type ProviderRefundV1,
  type RefundInput,
  type RefundLookupInput,
  type ProviderPaymentStatus,
  type ProviderPaymentV1,
  type WebhookInput,
  type WebhookResult,
} from "@chaanavya/contracts/integrations/payment-gateway"
import { PaymentConfigError, razorpayClient, type Fetch, type RazorpayConfig } from "./config.ts"

/** The Razorpay webhook events the payment module acts on, and their provider-neutral names (Stage 14.09). */
const WEBHOOK_TYPES: Readonly<Record<string, ProviderPaymentEventV1["type"]>> = Object.freeze({
  "payment.authorized": "payment.authorized",
  "payment.captured": "payment.captured",
  "payment.failed": "payment.failed",
  "refund.processed": "refund.processed",
  "refund.failed": "refund.failed",
})

type RazorpayEvent = { entity?: unknown; event?: unknown; created_at?: number; payload?: { payment?: { entity?: unknown }; refund?: { entity?: unknown } } }
type RazorpayPayment = { id: string; entity: "payment"; order_id: string; amount: number; currency: "INR" }
type RazorpayRefund = { id: string; entity: "refund"; payment_id: string; amount: number; currency: "INR" }

const isPayment = (value: unknown): value is RazorpayPayment => {
  const p = value as RazorpayPayment | null
  return Boolean(p) && p!.entity === "payment" && /^pay_[A-Za-z0-9]{1,40}$/.test(String(p!.id)) && /^order_[A-Za-z0-9]{1,40}$/.test(String(p!.order_id)) && Number.isSafeInteger(p!.amount) && p!.amount > 0 && p!.currency === "INR"
}
const isRefund = (value: unknown, paymentId: string): value is RazorpayRefund => {
  const r = value as RazorpayRefund | null
  return Boolean(r) && r!.entity === "refund" && /^rfnd_[A-Za-z0-9]{1,40}$/.test(String(r!.id)) && r!.payment_id === paymentId && Number.isSafeInteger(r!.amount) && r!.amount > 0 && r!.currency === "INR"
}

/** A payment as Razorpay's payments API returns it (Stage 14.11): only the fields we read. */
type LookedUpPayment = { id: string; entity: "payment"; order_id: string; amount: number; currency: string; status: string; captured: boolean; amount_refunded?: number; created_at: number }

const isLookedUpPayment = (value: unknown): value is LookedUpPayment => {
  const p = value as LookedUpPayment | null
  return (
    Boolean(p) &&
    p!.entity === "payment" &&
    /^pay_[A-Za-z0-9]{1,40}$/.test(String(p!.id)) &&
    /^order_[A-Za-z0-9]{1,40}$/.test(String(p!.order_id)) &&
    Number.isSafeInteger(p!.amount) &&
    p!.amount > 0 &&
    typeof p!.currency === "string" &&
    typeof p!.status === "string" &&
    typeof p!.captured === "boolean" &&
    (p!.amount_refunded === undefined || (Number.isSafeInteger(p!.amount_refunded) && p!.amount_refunded >= 0)) &&
    Number.isSafeInteger(p!.created_at)
  )
}

/** Razorpay's payment status in provider-neutral words; anything else is "unknown", never a guess. */
function paymentStatusOf(p: LookedUpPayment): ProviderPaymentStatus {
  if (p.status === "refunded") return "refunded"
  if (p.status === "captured") return (p.amount_refunded ?? 0) > 0 ? "partially_refunded" : "captured"
  if (p.status === "authorized" || p.status === "failed" || p.status === "created") return p.status
  return "unknown"
}

/** A refund as Razorpay's refunds API returns it (Stage 14.16): only the fields we read. */
type RazorpayRefundEntity = { id: string; entity: "refund"; payment_id: string; amount: number; currency: string; status: string; notes?: Record<string, unknown> | null }

const isRefundEntity = (value: unknown): value is RazorpayRefundEntity => {
  const r = value as RazorpayRefundEntity | null
  return Boolean(r) && r!.entity === "refund" && /^rfnd_[A-Za-z0-9]{1,40}$/.test(String(r!.id)) && /^pay_[A-Za-z0-9]{1,40}$/.test(String(r!.payment_id)) && Number.isSafeInteger(r!.amount) && r!.amount > 0 && typeof r!.currency === "string" && typeof r!.status === "string"
}

/** What Razorpay's checkout hands the browser when the buyer finishes (sorted). */
const RETURN_FIELDS = ["razorpay_order_id", "razorpay_payment_id", "razorpay_signature"]

/** The shop name Razorpay's checkout shows to the buyer. */
const MERCHANT_NAME = "Chaanavya"

type RazorpayOrder = { id: string; entity: string; amount: number; currency: string; status: string; receipt?: string; notes?: Record<string, unknown> | null }

const isRazorpayOrder = (value: unknown): value is RazorpayOrder => {
  const o = value as RazorpayOrder | null
  return Boolean(o) && typeof o?.id === "string" && /^order_[A-Za-z0-9]+$/.test(o.id) && o.entity === "order" && Number.isSafeInteger(o.amount) && typeof o.currency === "string" && typeof o.status === "string"
}

/** Builds the session the browser needs from a Razorpay order we opened (or opened before). */
function session(config: RazorpayConfig, providerOrderId: string, input: CreateCheckoutInput): CheckoutSessionV1 {
  return {
    providerOrderId,
    expiresAt: null as IsoDateTime | null,
    next: {
      kind: "embedded",
      // Public values only: the key ID is meant for the browser; the secret never leaves the server.
      publicParams: { key: config.keyId, order_id: providerOrderId, amount: String(input.amount.amountPaise), currency: input.amount.currency, name: MERCHANT_NAME, description: `Order ${input.reference}` },
    },
  }
}

/**
 * How hard the adapter tries before it gives up (Stage 14.05). The whole checkout gets one time budget,
 * shorter than the payment module's lock (apps/api/src/payments/start.ts), and every call's timeout is cut
 * to what is left of it. Only a call that is safe to repeat is repeated:
 *   - a lookup (GET) changes nothing, so it is repeated after a timeout, a lost connection, 429 or 5xx;
 *   - creating an order (POST) is repeated only when Razorpay certainly did not act: the connection was never
 *     made, or it answered 429. After a timeout or a 5xx it may have opened the order, so the adapter asks
 *     Razorpay for the attempt's order instead of creating another.
 */
export type RetryPolicy = { attempts: number; backoffMs: readonly number[]; budgetMs: number }
export const RAZORPAY_RETRY: RetryPolicy = Object.freeze({ attempts: 3, backoffMs: Object.freeze([250, 750]), budgetMs: 15_000 })
export type RazorpayAdapterOptions = { retry?: Partial<RetryPolicy>; sleep?: (ms: number) => Promise<void>; now?: () => number }

/** Below this, a call cannot finish in time, so it is not started. */
const MIN_CALL_MS = 250
/** Connection failures that mean the request never reached Razorpay. */
const NOT_SENT = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"])

type Outcome =
  | { kind: "answered"; status: number; body: unknown }
  | { kind: "not_sent"; error: PaymentAdapterError }
  | { kind: "unknown"; error: PaymentAdapterError }

const transient = (o: Outcome) => o.kind !== "answered" || o.status === 429 || o.status >= 500
const certainlyNotActed = (o: Outcome) => o.kind === "not_sent" || (o.kind === "answered" && o.status === 429)

export function razorpayAdapter(config: RazorpayConfig, fetchImpl?: Fetch, options: RazorpayAdapterOptions = {}): PaymentAdapter {
  const client = razorpayClient(config, fetchImpl)
  const policy: RetryPolicy = { ...RAZORPAY_RETRY, ...options.retry }
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const now = options.now ?? Date.now

  async function send(method: "GET" | "POST", path: string, deadline: number, body?: unknown, query?: Record<string, string>): Promise<Outcome> {
    const left = deadline - now()
    if (left < MIN_CALL_MS) return { kind: "not_sent", error: new PaymentAdapterError("razorpay", "timeout", "no time was left to ask Razorpay") }
    try {
      const response = await client.request(method, path, body, { query, timeoutMs: left })
      return { kind: "answered", status: response.status, body: await response.json().catch(() => null) }
    } catch (error) {
      if (error instanceof PaymentAdapterError || error instanceof PaymentConfigError) throw error
      const { name, cause } = (error ?? {}) as { name?: string; cause?: { code?: string } }
      if (name === "TimeoutError" || name === "AbortError") return { kind: "unknown", error: new PaymentAdapterError("razorpay", "timeout", "Razorpay did not answer in time") }
      return { kind: NOT_SENT.has(cause?.code ?? "") ? "not_sent" : "unknown", error: new PaymentAdapterError("razorpay", "unavailable", "Razorpay could not be reached") }
    }
  }

  /** Repeats a transient outcome while `safe` allows it, within the attempts and the time budget. */
  async function withRetries(safe: (o: Outcome) => boolean, deadline: number, call: () => Promise<Outcome>): Promise<Outcome> {
    let outcome = await call()
    for (let i = 1; i < policy.attempts && transient(outcome) && safe(outcome); i += 1) {
      const wait = policy.backoffMs[Math.min(i - 1, policy.backoffMs.length - 1)] ?? 0
      if (now() + wait + MIN_CALL_MS > deadline) break
      await sleep(wait)
      outcome = await call()
    }
    return outcome
  }

  function refusal(status: number, what: string) {
    if (status === 401 || status === 403) return new PaymentAdapterError("razorpay", "misconfigured", "Razorpay refused the key")
    if (status >= 500 || status === 429) return new PaymentAdapterError("razorpay", "unavailable", `Razorpay answered ${status}`)
    return new PaymentAdapterError("razorpay", "rejected", `Razorpay refused ${what} (${status})`)
  }

  /**
   * The Razorpay order already opened for this attempt, if any: found by the receipt (the order number) and
   * the attempt id in its notes. Only an order for exactly the attempt's amount in INR counts; one that does
   * not match was never believed, never reached a browser, and so can never be paid.
   */
  async function findOrderFor(input: CreateCheckoutInput, deadline: number): Promise<RazorpayOrder | null> {
    const outcome = await withRetries(() => true, deadline, () => send("GET", "/v1/orders", deadline, undefined, { receipt: input.reference, count: "100" }))
    if (outcome.kind !== "answered") throw outcome.error
    if (outcome.status >= 400) throw refusal(outcome.status, "the lookup")
    const items = (outcome.body as { items?: unknown } | null)?.items
    if (!Array.isArray(items)) throw new PaymentAdapterError("razorpay", "invalid_response", "Razorpay's answer was not a list of orders")
    return items.filter(isRazorpayOrder).find(o => o.notes?.attempt_id === input.attemptId && o.amount === input.amount.amountPaise && o.currency === "INR") ?? null
  }

  async function createCheckout(input: CreateCheckoutInput): Promise<CheckoutSessionV1> {
    if (!Number.isSafeInteger(input.amount.amountPaise) || input.amount.amountPaise < 100) throw new PaymentAdapterError("razorpay", "rejected", "an amount below ₹1 cannot be paid")
    if (input.amount.currency !== "INR") throw new PaymentAdapterError("razorpay", "rejected", "only INR can be paid")
    // A retry for an attempt that already has a Razorpay order rebuilds its session: never a second order.
    if (input.existingProviderOrderId) return session(config, input.existingProviderOrderId, input)

    const deadline = now() + policy.budgetMs
    // An earlier request may have opened the order and lost the answer (a timeout, a crash): ask first.
    const earlier = await findOrderFor(input, deadline)
    if (earlier) return session(config, earlier.id, input)

    const created = await withRetries(certainlyNotActed, deadline, () =>
      send("POST", "/v1/orders", deadline, { amount: input.amount.amountPaise, currency: "INR", receipt: input.reference, notes: { attempt_id: input.attemptId } }),
    )
    if (created.kind === "answered" && !transient(created)) {
      if (created.status >= 400) throw refusal(created.status, "the order")
      const body = created.body
      if (!isRazorpayOrder(body)) throw new PaymentAdapterError("razorpay", "invalid_response", "Razorpay's answer was not an order")
      // Believe nothing we did not ask for: the order must be new and for exactly our amount in INR.
      if (body.amount !== input.amount.amountPaise || body.currency !== "INR" || body.status !== "created") {
        throw new PaymentAdapterError("razorpay", "invalid_response", "Razorpay's order does not match the amount asked for")
      }
      return session(config, body.id, input)
    }
    const failure = created.kind === "answered" ? refusal(created.status, "the order") : created.error
    if (certainlyNotActed(created)) throw failure

    // The outcome is unknown: Razorpay may have opened the order. Ask for it before anything new is created.
    const adopted = await findOrderFor(input, deadline).catch((error: unknown) => {
      if (error instanceof PaymentAdapterError && error.outcomeUnknown) return null
      throw error
    })
    if (adopted) return session(config, adopted.id, input)
    throw failure
  }

  /**
   * Reads what Razorpay's checkout handed the browser (Stage 14.07): exactly its three fields, each in
   * Razorpay's format, for the Razorpay order we stored. Anything else is refused. Then the signature
   * (Stage 14.08) is checked over the order we stored, never the one the browser names, and the payment id it
   * sent: a payment id moved to another order, or any changed character, does not verify.
   */
  async function verifyReturn(input: CheckoutReturnInput): Promise<CheckoutReturnResult> {
    const returned = input.returned
    const keys = Object.keys(returned).sort()
    if (keys.join(",") !== RETURN_FIELDS.join(",")) throw new PaymentAdapterError("razorpay", "rejected", "the checkout return does not have Razorpay's fields")
    if (!/^pay_[A-Za-z0-9]{1,40}$/.test(returned.razorpay_payment_id)) throw new PaymentAdapterError("razorpay", "rejected", "the payment id is not Razorpay's")
    if (!/^order_[A-Za-z0-9]{1,40}$/.test(returned.razorpay_order_id)) throw new PaymentAdapterError("razorpay", "rejected", "the order id is not Razorpay's")
    if (!/^[0-9a-f]{64}$/.test(returned.razorpay_signature)) throw new PaymentAdapterError("razorpay", "rejected", "the signature is not Razorpay's")
    if (returned.razorpay_order_id !== input.storedProviderOrderId) throw new PaymentAdapterError("razorpay", "rejected", "the return is for another Razorpay order")
    if (!config.checkoutSignatureMatches(input.storedProviderOrderId, returned.razorpay_payment_id, returned.razorpay_signature)) return { verified: false }
    return { verified: true, providerPaymentId: returned.razorpay_payment_id }
  }

  /**
   * A Razorpay webhook (Stage 14.09). In this order, and nothing is read before the step above it passes:
   *   1. the signature (X-Razorpay-Signature) over the exact bytes received, with the webhook secret;
   *   2. the event id (X-Razorpay-Event-Id), which later steps use to take each event once;
   *   3. the body: a Razorpay event, with a type we know, and the entity that type must carry, for INR.
   * An event type we do not act on is valid with no event; anything else is not valid.
   */
  async function parseWebhook(input: WebhookInput): Promise<WebhookResult> {
    const bytes = input.rawBytes ?? Buffer.from(input.rawBody, "utf8")
    const signature = input.headers["x-razorpay-signature"] ?? ""
    if (!/^[0-9a-f]{64}$/.test(signature) || !config.webhookSignatureMatches(bytes, signature)) return { valid: false }
    const eventId = input.headers["x-razorpay-event-id"] ?? ""
    if (!/^[A-Za-z0-9]{8,64}$/.test(eventId)) return { valid: false }

    let body: RazorpayEvent
    try {
      body = JSON.parse(Buffer.from(bytes).toString("utf8")) as RazorpayEvent
    } catch {
      return { valid: false }
    }
    if (!body || typeof body !== "object" || body.entity !== "event" || typeof body.event !== "string" || !Number.isSafeInteger(body.created_at) || !body.payload || typeof body.payload !== "object") return { valid: false }
    if (!/^[a-z_]+(\.[a-z_]+)+$/.test(body.event)) return { valid: false }
    const type = WEBHOOK_TYPES[body.event]
    if (!type) return { valid: true, event: null }

    const payment = body.payload.payment?.entity
    if (!isPayment(payment)) return { valid: false }
    let refund: RazorpayRefund | null = null
    if (type.startsWith("refund.")) {
      const entity = body.payload.refund?.entity
      if (!isRefund(entity, payment.id)) return { valid: false }
      refund = entity
    }
    const money = refund ?? payment
    const event: ProviderPaymentEventV1 = {
      provider: "razorpay",
      eventId,
      fingerprint: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      type,
      providerOrderId: payment.order_id,
      providerPaymentId: payment.id,
      providerRefundId: refund ? refund.id : null,
      amount: { amountPaise: money.amount, currency: "INR" } as MoneyPaise,
      occurredAt: new Date((body.created_at as number) * 1000).toISOString() as IsoDateTime,
    }
    return { valid: true, event }
  }

  /**
   * What Razorpay itself holds for a payment (Stage 14.11): the authoritative answer a webhook or a browser
   * can only hint at. By payment id when we have one, otherwise the order's payments (the captured one, else
   * else one authorized or in progress, else the latest). Repeated like any lookup (it changes nothing); an answer that is not a Razorpay payment, or
   * that cannot be read, is never guessed at.
   */
  async function lookupPayment(input: PaymentLookupInput): Promise<ProviderPaymentV1> {
    if (!/^order_[A-Za-z0-9]{1,40}$/.test(input.providerOrderId)) throw new PaymentAdapterError("razorpay", "rejected", "not a Razorpay order id")
    if (input.providerPaymentId !== null && !/^pay_[A-Za-z0-9]{1,40}$/.test(input.providerPaymentId)) throw new PaymentAdapterError("razorpay", "rejected", "not a Razorpay payment id")
    const deadline = now() + policy.budgetMs
    const path = input.providerPaymentId ? `/v1/payments/${input.providerPaymentId}` : `/v1/orders/${input.providerOrderId}/payments`
    const outcome = await withRetries(() => true, deadline, () => send("GET", path, deadline))
    if (outcome.kind !== "answered") throw outcome.error
    if (outcome.status === 404) throw new PaymentAdapterError("razorpay", "not_found", "Razorpay has no such payment")
    if (outcome.status >= 400) throw refusal(outcome.status, "the lookup")

    let payment: unknown = outcome.body
    if (!input.providerPaymentId) {
      const items = (outcome.body as { items?: unknown } | null)?.items
      if (!Array.isArray(items)) throw new PaymentAdapterError("razorpay", "invalid_response", "Razorpay's answer was not a list of payments")
      const payments = items.filter(isLookedUpPayment)
      if (payments.length !== items.length) throw new PaymentAdapterError("razorpay", "invalid_response", "Razorpay's answer held something that is not a payment")
      if (payments.length === 0) throw new PaymentAdapterError("razorpay", "not_found", "Razorpay has no payment for this order yet")
      // Money first: a captured payment, then one authorized or still in progress (Stage 14.13), and only then
      // the latest, so a newer failed try never hides a payment that went through.
      payment = payments.find(p => p.captured === true) ?? payments.find(p => p.status === "authorized" || p.status === "created") ?? payments.reduce((a, b) => (b.created_at > a.created_at ? b : a))
    }
    if (!isLookedUpPayment(payment)) throw new PaymentAdapterError("razorpay", "invalid_response", "Razorpay's answer was not a payment")
    const status = paymentStatusOf(payment)
    return {
      providerOrderId: payment.order_id,
      providerPaymentId: payment.id,
      status,
      amount: { amountPaise: payment.amount, currency: "INR" } as MoneyPaise,
      capturedAmount: payment.captured === true ? ({ amountPaise: payment.amount, currency: "INR" } as MoneyPaise) : null,
      refundedAmount: { amountPaise: payment.amount_refunded ?? 0, currency: "INR" } as MoneyPaise,
      capturedAt: null,
      reportedCurrency: payment.currency,
    }
  }

  async function captureStatus(input: PaymentLookupInput): Promise<CaptureStatusV1> {
    const checkedAt = new Date(now()).toISOString() as IsoDateTime
    try {
      const p = await lookupPayment(input)
      const state = p.capturedAmount ? "captured" : p.status === "failed" ? "failed" : p.status === "unknown" ? "unknown" : "not_captured"
      return { state, providerPaymentId: p.providerPaymentId, capturedAmount: p.capturedAmount, checkedAt }
    } catch (error) {
      if (error instanceof PaymentAdapterError && error.kind === "not_found") return { state: "not_captured", providerPaymentId: null, capturedAmount: null, checkedAt }
      throw error
    }
  }

  /** The refunds Razorpay holds for a payment, read strictly; an answer that is not a list of refunds is never guessed at. */
  async function refundsOf(providerPaymentId: string, deadline: number): Promise<RazorpayRefundEntity[]> {
    const outcome = await withRetries(() => true, deadline, () => send("GET", `/v1/payments/${providerPaymentId}/refunds`, deadline))
    if (outcome.kind !== "answered") throw outcome.error
    if (outcome.status >= 400) throw refusal(outcome.status, "the refund lookup")
    const items = (outcome.body as { items?: unknown } | null)?.items
    if (!Array.isArray(items) || !items.every(isRefundEntity)) throw new PaymentAdapterError("razorpay", "invalid_response", "Razorpay's answer was not a list of refunds")
    return items
  }

  function refundView(r: RazorpayRefundEntity): ProviderRefundV1 {
    return { providerRefundId: r.id, providerPaymentId: r.payment_id, amount: { amountPaise: r.amount, currency: "INR" } as MoneyPaise, status: r.status === "processed" ? "processed" : r.status === "failed" ? "failed" : r.status === "pending" ? "pending" : "unknown" }
  }

  /**
   * A refund of part or all of a captured payment (Stage 14.16), sandbox only. Our refund key goes in the
   * refund's notes, and Razorpay is asked for a refund with that key before one is created and after any
   * answer that may have been lost, so a retry never refunds twice. Razorpay's answer must be a refund of
   * that payment, for exactly the amount, in INR.
   */
  async function refund(input: RefundInput): Promise<ProviderRefundV1> {
    if (!/^pay_[A-Za-z0-9]{1,40}$/.test(input.providerPaymentId)) throw new PaymentAdapterError("razorpay", "rejected", "not a Razorpay payment id")
    if (!Number.isSafeInteger(input.amount.amountPaise) || input.amount.amountPaise < 100) throw new PaymentAdapterError("razorpay", "rejected", "a refund below ₹1 cannot be made")
    if (input.amount.currency !== "INR") throw new PaymentAdapterError("razorpay", "rejected", "only INR can be refunded")
    const deadline = now() + policy.budgetMs
    const ours = (r: RazorpayRefundEntity) => r.notes?.refund_key === input.key && r.payment_id === input.providerPaymentId && r.amount === input.amount.amountPaise && r.currency === "INR"

    const earlier = (await refundsOf(input.providerPaymentId, deadline)).find(ours)
    if (earlier) return refundView(earlier)

    const created = await withRetries(certainlyNotActed, deadline, () =>
      send("POST", `/v1/payments/${input.providerPaymentId}/refund`, deadline, { amount: input.amount.amountPaise, speed: "normal", notes: { refund_key: input.key, reason: input.reason.slice(0, 200) } }),
    )
    if (created.kind === "answered" && !transient(created)) {
      if (created.status >= 400) throw refusal(created.status, "the refund")
      if (!isRefundEntity(created.body) || !ours({ ...created.body, notes: { refund_key: input.key } })) throw new PaymentAdapterError("razorpay", "invalid_response", "Razorpay's refund does not match the refund asked for")
      return refundView(created.body)
    }
    const failure = created.kind === "answered" ? refusal(created.status, "the refund") : created.error
    if (certainlyNotActed(created)) throw failure
    // The outcome is unknown: Razorpay may have made the refund. Ask before anything else.
    const adopted = await refundsOf(input.providerPaymentId, deadline)
      .then(list => list.find(ours))
      .catch((error: unknown) => {
        if (error instanceof PaymentAdapterError && error.outcomeUnknown) return undefined
        throw error
      })
    if (adopted) return refundView(adopted)
    throw failure
  }

  /** A refund by Razorpay's id. Finding one by our key needs its payment, so only the id is supported here. */
  async function lookupRefund(input: RefundLookupInput): Promise<ProviderRefundV1> {
    if (!input.providerRefundId || !/^rfnd_[A-Za-z0-9]{1,40}$/.test(input.providerRefundId)) throw new PaymentAdapterError("razorpay", "rejected", "a Razorpay refund id is needed")
    const deadline = now() + policy.budgetMs
    const outcome = await withRetries(() => true, deadline, () => send("GET", `/v1/refunds/${input.providerRefundId}`, deadline))
    if (outcome.kind !== "answered") throw outcome.error
    if (outcome.status === 404) throw new PaymentAdapterError("razorpay", "not_found", "Razorpay has no such refund")
    if (outcome.status >= 400) throw refusal(outcome.status, "the refund lookup")
    if (!isRefundEntity(outcome.body) || outcome.body.id !== input.providerRefundId) throw new PaymentAdapterError("razorpay", "invalid_response", "Razorpay's answer was not that refund")
    return refundView(outcome.body)
  }

  return {
    provider: "razorpay",
    mode: config.mode,
    capabilities: { checkout: "embedded", separateCapture: true, partialRefunds: true },
    createCheckout,
    verifyReturn,
    parseWebhook,
    lookupPayment,
    captureStatus,
    refund,
    lookupRefund,
  }
}
