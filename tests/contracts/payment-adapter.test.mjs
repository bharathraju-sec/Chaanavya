// CHV-S14-M01: the payment domain has no Razorpay-specific assumptions. The provider-neutral PaymentAdapter
// contract (packages/contracts/src/integrations/payment-gateway.ts) is driven, through one shared set of
// checks, by two very different in-memory providers (tests/contracts/fixtures/payment-adapters.ts): an
// embedded, authorize-then-capture provider shaped like Razorpay and a redirect, capture-at-once provider
// shaped like PhonePe. The payment code itself names no provider, and PhonePe stays a valid provider.
import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { classifyProviderEvent } from "../../packages/contracts/src/modules/state-machines.ts"
import { PAYMENT_ADAPTER_METHODS, PaymentAdapterError } from "../../packages/contracts/src/integrations/payment-gateway.ts"
import { PaymentProvider } from "../../apps/api/src/db/generated/enums.ts"
import { embeddedAdapter, keyOf, redirectAdapter } from "./fixtures/payment-adapters.ts"

const ROOT = join(import.meta.dirname, "..", "..")
const INR = paise => ({ amountPaise: paise, currency: "INR" })
const checkout = (kit, key = `key-${Math.random()}`, paise = 249900) =>
  kit.adapter.createCheckout({ attemptId: "attempt-1", reference: "CHV-1001", amount: INR(paise), returnUrl: "https://shop.example.test/checkout/return", key: keyOf(key) })
/** Make the provider take the money, in its own words. */
const takePayment = (kit, ref) => (kit.adapter.provider === "razorpay" ? kit.pay(ref, "captured", kit.fake.payment(ref).amount) : kit.pay(ref, "COMPLETED"))

const PROVIDERS = [
  ["embedded, authorize then capture (Razorpay-shaped)", embeddedAdapter],
  ["redirect, captured at once (PhonePe-shaped)", redirectAdapter],
]

for (const [name, make] of PROVIDERS) {
  describe(`CHV-S14-M01 one contract, ${name}`, () => {
    test("implements every method and declares what it can do", () => {
      const { adapter } = make()
      for (const method of PAYMENT_ADAPTER_METHODS) assert.equal(typeof adapter[method], "function", method)
      assert.ok(["razorpay", "phonepe"].includes(adapter.provider))
      assert.equal(adapter.mode, "test")
      assert.ok(["embedded", "redirect"].includes(adapter.capabilities.checkout))
      assert.equal(typeof adapter.capabilities.separateCapture, "boolean")
    })

    test("a checkout carries the server's amount in paise, and the same key returns the same checkout", async () => {
      const kit = make()
      const first = await checkout(kit, "same-key", 249900)
      const again = await checkout(kit, "same-key", 249900)
      assert.equal(again.providerOrderId, first.providerOrderId)
      assert.equal(kit.fake.checkouts.size, 1)
      assert.equal(kit.fake.payment(first.providerOrderId).amount, 249900)
      // The browser is told how to continue in neutral terms, whichever kind the provider uses.
      assert.equal(first.next.kind, kit.adapter.capabilities.checkout)
      if (first.next.kind === "redirect") assert.match(first.next.url, /^https:\/\//)
      else assert.ok(Object.values(first.next.publicParams).every(v => typeof v === "string"))
      assert.ok(!JSON.stringify(first).match(/secret/i), "no secret reaches the browser")
    })

    test("the browser's return is a hint: forged returns are refused, and checking one changes nothing", async () => {
      const kit = make()
      const { providerOrderId } = await checkout(kit)
      const before = await kit.adapter.lookupPayment({ providerOrderId, providerPaymentId: null })
      for (const returned of [{}, { paymentRef: "pay_forged", proof: "0".repeat(64) }, { transactionRef: "MTsomeoneelse" }]) {
        assert.deepEqual(await kit.adapter.verifyReturn({ storedProviderOrderId: providerOrderId, returned }), { verified: false }, JSON.stringify(returned))
      }
      assert.deepEqual(await kit.adapter.lookupPayment({ providerOrderId, providerPaymentId: null }), before)
      const paymentId = takePayment(kit, providerOrderId)
      const genuine = kit.adapter.provider === "razorpay" ? { paymentRef: paymentId, proof: kit.proof(providerOrderId, paymentId) } : { transactionRef: providerOrderId }
      assert.deepEqual(await kit.adapter.verifyReturn({ storedProviderOrderId: providerOrderId, returned: genuine }), { verified: true, providerPaymentId: paymentId })
    })

    test("capture status in neutral words; a provider state the adapter cannot map is unknown, never a guess", async () => {
      const kit = make()
      const { providerOrderId } = await checkout(kit)
      assert.equal((await kit.adapter.captureStatus({ providerOrderId, providerPaymentId: null })).state, "not_captured")
      const paymentId = takePayment(kit, providerOrderId)
      const captured = await kit.adapter.captureStatus({ providerOrderId, providerPaymentId: paymentId })
      assert.deepEqual([captured.state, captured.providerPaymentId, captured.capturedAmount], ["captured", paymentId, INR(249900)])

      const other = await checkout(kit, "another")
      kit.pay(other.providerOrderId, kit.adapter.provider === "razorpay" ? "on_hold" : "INTERVENTION_REQUIRED")
      assert.equal((await kit.adapter.lookupPayment({ providerOrderId: other.providerOrderId, providerPaymentId: null })).status, "unknown")
      assert.equal((await kit.adapter.captureStatus({ providerOrderId: other.providerOrderId, providerPaymentId: null })).state, "unknown")
    })

    test("webhooks: verified events take one shape, a forged body is refused, events we do not act on are null", async () => {
      const kit = make()
      const { providerOrderId } = await checkout(kit)
      const raw = kit.adapter.provider === "razorpay"
        ? JSON.stringify({ id: "evt_1", event: "payment.captured", order: providerOrderId, payment: "pay_1", amount: 249900 })
        : JSON.stringify({ eventRef: "evt_1", state: "COMPLETED", merchantTransactionId: providerOrderId, transactionId: "T1", amount: 249900 })
      const header = kit.adapter.provider === "razorpay" ? "x-fake-signature" : "x-verify"
      const ok = await kit.adapter.parseWebhook({ rawBody: raw, headers: { [header]: kit.sign(raw) } })
      assert.equal(ok.valid, true)
      const event = ok.event
      assert.deepEqual(Object.keys(event).sort(), ["amount", "eventId", "fingerprint", "occurredAt", "provider", "providerOrderId", "providerPaymentId", "providerRefundId", "type"])
      assert.deepEqual([event.provider, event.type, event.providerOrderId, event.amount], [kit.adapter.provider, "payment.captured", providerOrderId, INR(249900)])
      // The payment module's duplicate and conflict rules work on it unchanged, scoped by provider.
      const seen = new Map([[`${event.provider}:${event.eventId}`, event.fingerprint]])
      assert.equal(classifyProviderEvent(seen, event), "duplicate")
      assert.equal(classifyProviderEvent(seen, { ...event, fingerprint: "sha256:tampered" }), "conflict")

      assert.deepEqual(await kit.adapter.parseWebhook({ rawBody: raw.replace("249900", "100"), headers: { [header]: kit.sign(raw) } }), { valid: false })
      assert.deepEqual(await kit.adapter.parseWebhook({ rawBody: raw, headers: {} }), { valid: false })
      const ignored = kit.adapter.provider === "razorpay" ? JSON.stringify({ id: "evt_2", event: "order.notified", order: providerOrderId, payment: "", amount: 0 }) : JSON.stringify({ eventRef: "evt_2", state: "PENDING", merchantTransactionId: providerOrderId, transactionId: "", amount: 0 })
      assert.deepEqual(await kit.adapter.parseWebhook({ rawBody: ignored, headers: { [header]: kit.sign(ignored) } }), { valid: true, event: null })
    })

    test("refunds: the same key never refunds twice, and more than was captured is refused", async () => {
      const kit = make()
      const { providerOrderId } = await checkout(kit)
      const paymentId = takePayment(kit, providerOrderId)
      const input = { providerOrderId, providerPaymentId: paymentId, amount: INR(100000), reason: "buyer cancelled", key: keyOf("refund-1") }
      const first = await kit.adapter.refund(input)
      const again = await kit.adapter.refund(input)
      assert.deepEqual(again, first)
      assert.equal((await kit.adapter.lookupPayment({ providerOrderId, providerPaymentId: paymentId })).refundedAmount.amountPaise, 100000, "refunded once")
      assert.deepEqual(await kit.adapter.lookupRefund({ providerRefundId: first.providerRefundId, key: keyOf("refund-1") }), first)
      const over = await kit.adapter.refund({ ...input, amount: INR(200000), key: keyOf("refund-2") }).then(() => null, e => e)
      assert.ok(over instanceof PaymentAdapterError)
      assert.deepEqual([over.kind, over.outcomeUnknown], ["rejected", false])
    })

    test("a timeout leaves the outcome unknown: retryable with the same key, never read as a failed payment", async () => {
      const kit = make()
      const { providerOrderId } = await checkout(kit)
      kit.fake.failNext = new PaymentAdapterError(kit.adapter.provider, "timeout", "no answer in time")
      const error = await kit.adapter.captureStatus({ providerOrderId, providerPaymentId: null }).then(() => null, e => e)
      assert.ok(error instanceof PaymentAdapterError)
      assert.deepEqual([error.kind, error.outcomeUnknown, error.retryable, error.provider], ["timeout", true, true, kit.adapter.provider])
      kit.fake.failNext = new PaymentAdapterError(kit.adapter.provider, "misconfigured", "missing key")
      const config = await checkout(kit).then(() => null, e => e)
      assert.deepEqual([config.kind, config.outcomeUnknown, config.retryable], ["misconfigured", false, false])
    })
  })
}

describe("CHV-S14-M01 the payment code names no provider", () => {
  // The payment domain: the contracts, and every API module that moves a payment or acts on one.
  const DOMAIN = [
    "packages/contracts/src/modules/payment.ts",
    "packages/contracts/src/integrations/payment-gateway.ts",
    "apps/api/src/orders/capture.ts",
    "apps/api/src/orders/cancel.ts",
    "apps/api/src/orders/recovery.ts",
    "apps/api/src/orders/admin.ts",
    "apps/api/src/db/transitions.ts",
    "apps/api/src/inventory/reservations.ts",
    "apps/api/src/payments/attempts.ts",
  ]
  const code = path => readFileSync(join(ROOT, path), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1")

  test("no provider name, key prefix or provider field name in the payment code (comments aside)", () => {
    for (const path of DOMAIN) {
      const source = code(path)
      for (const word of [/razorpay/i, /phonepe/i, /\brzp_/, /\bpay_[A-Za-z0-9]/, /x-razorpay/i, /x-verify/i, /merchantTransactionId/]) {
        assert.doesNotMatch(source, word, `${path} names ${word}`)
      }
    }
  })

  test("the contract uses no provider-shaped fields, and no card data can pass through it", () => {
    const contract = code("packages/contracts/src/integrations/payment-gateway.ts") + code("packages/contracts/src/modules/payment.ts")
    for (const field of ["signature", "receipt", "notes", "razorpay_order_id", "razorpay_payment_id", "merchantId", "saltKey"]) {
      assert.doesNotMatch(contract, new RegExp(`\\b${field}\\??\\s*:`), `field ${field}`)
    }
    for (const card of [/card(number)?\??\s*:/i, /\bcvv/i, /\bcvc/i, /\bexpiry/i, /\bpan\??\s*:/i]) assert.doesNotMatch(contract, card)
  })

  test("providers are named only in the registries, and PhonePe stays a valid provider", () => {
    assert.match(code("packages/contracts/src/modules/common.ts"), /PaymentProviderName = "razorpay" \| "phonepe"/)
    assert.deepEqual(Object.values(PaymentProvider).sort(), ["phonepe", "razorpay"], "the database accepts both")
    // The launch list (owner decision, 30 October 2026) is where a provider is switched on, not the domain.
    assert.match(code("packages/contracts/src/modules/state-machines.ts"), /PAYMENT_PROVIDERS = \["razorpay"\]/)
  })
})
