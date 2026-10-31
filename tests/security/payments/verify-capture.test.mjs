// CHV-S14-M11: a captured wrong amount cannot complete an order. A reported capture (a webhook event from the
// inbox) is checked against Razorpay's own answer (the adapter's lookupPayment) and against the attempt and
// order (apps/api/src/payments/verify-capture.ts), and only the provider's amount reaches the Stage 13.10
// capture bridge (apps/api/src/orders/capture.ts). Orders are placed and checkouts opened through the web
// host's forwarder; Razorpay is a stand-in on the network whose payments the test sets; keys and ids are fake.
import { after, before, beforeEach, describe, test } from "node:test"
import assert from "node:assert/strict"
import { randomBytes, randomUUID } from "node:crypto"
import { apiModule, call, createStaff, Jar, newIp, setup } from "../auth/helpers.mjs"

let ctx, forward, owner, verify, capture, payments, adapterModule, configModule
let n = 0

const SANDBOX = { PAYMENT_MODE: "test", RAZORPAY_KEY_ID: "rzp_test_FAKE0000000021", RAZORPAY_KEY_SECRET: "fake-key-secret-14-11-0001", RAZORPAY_WEBHOOK_SECRET: "fake-webhook-secret-14-11-0001" }
const cart = (method, path, { jar, body, headers = {} } = {}) => call(forward, `/api/cart${path}`, { method, jar, body, headers, ip: newIp() })
const address = { name: "Synthetic Buyer", phone: "+91 60000 00000", line1: "1 Example Road", line2: null, landmark: null, city: "Bengaluru", district: "Bengaluru Urban", stateCode: "IN-KA", pinCode: "560034" }

// ---- the Razorpay stand-in: orders (for the checkout) and payments (set by each test) --------------
const razorpay = { calls: [], orders: [], payments: new Map(), down: 0 }
const realFetch = globalThis.fetch
async function stubFetch(url, init) {
  if (!String(url).startsWith("https://api.razorpay.com/")) return realFetch(url, init)
  const { pathname, searchParams } = new URL(url)
  razorpay.calls.push({ method: init.method, path: pathname })
  if (razorpay.down > 0) {
    razorpay.down -= 1
    return { status: 503, json: async () => ({ error: { code: "SERVER_ERROR" } }) }
  }
  if (init.method === "POST" && pathname === "/v1/orders") {
    const body = JSON.parse(init.body)
    const order = { id: `order_Fake${razorpay.orders.length + 1}${randomBytes(3).toString("hex")}`, entity: "order", amount: body.amount, currency: body.currency, receipt: body.receipt, notes: body.notes, status: "created" }
    razorpay.orders.push(order)
    return { status: 200, json: async () => order }
  }
  if (pathname === "/v1/orders") {
    const items = razorpay.orders.filter(o => o.receipt === searchParams.get("receipt"))
    return { status: 200, json: async () => ({ entity: "collection", count: items.length, items }) }
  }
  const byOrder = pathname.match(/^\/v1\/orders\/(order_[A-Za-z0-9]+)\/payments$/)
  if (byOrder) {
    const items = [...razorpay.payments.values()].filter(p => p.answer?.order_id === byOrder[1]).map(p => p.answer)
    return { status: 200, json: async () => ({ entity: "collection", count: items.length, items }) }
  }
  const byId = pathname.match(/^\/v1\/payments\/(pay_[A-Za-z0-9]+)$/)
  if (byId) {
    const p = razorpay.payments.get(byId[1])
    if (!p) return { status: 404, json: async () => ({ error: { code: "BAD_REQUEST_ERROR", description: "The id provided does not exist" } }) }
    return { status: 200, json: async () => p.answer }
  }
  return { status: 404, json: async () => ({}) }
}

/** A shopper's pending order for one item at ₹1,899 (plus delivery), with its Razorpay checkout opened. */
async function shopper() {
  n += 1
  const p = await ctx.db.product.create({
    data: { handle: `fixture-verify-${n}`, title: `Fixture verify ${n}`, status: "active", publishedAt: new Date(), shippingRestriction: "none", variants: { create: [{ sku: `fixture-verify-${n}-m`, title: "M", optionKey: "size:m", pricePaise: 189900n, taxCategory: "apparel_cotton", weightGrams: 300 }] } },
    include: { variants: true },
  })
  await ctx.db.inventoryBalance.create({ data: { variantId: p.variants[0].id, onHand: 5, lastCountedAt: new Date() } })
  const jar = new Jar()
  assert.equal((await cart("POST", "/lines", { jar, body: { variantId: p.variants[0].id, quantity: 1 }, headers: { "idempotency-key": randomUUID() } })).status, 200)
  assert.equal((await cart("PUT", "/contact", { jar, body: { email: "buyer@example.com", shippingAddress: address } })).status, 200)
  const quote = (await cart("POST", "/quote", { jar, body: {} })).json.data
  const placed = await cart("POST", "/order", { jar, body: { quoteId: quote.id, expectedGrandTotal: quote.grandTotal }, headers: { "idempotency-key": randomUUID() } })
  assert.equal(placed.status, 201, JSON.stringify(placed.json))
  const opened = await cart("POST", `/order/${placed.json.data.id}/payment`, { jar, body: {}, headers: { "idempotency-key": randomUUID() } })
  assert.equal(opened.status, 200, JSON.stringify(opened.json))
  return { orderId: placed.json.data.id, total: placed.json.data.grandTotal.amountPaise, providerOrderId: opened.json.data.providerOrderId, attemptId: opened.json.data.attemptId, variantId: p.variants[0].id }
}

/** What Razorpay holds for a payment on the shopper's Razorpay order (fields from Razorpay's payments API). */
function razorpayHolds(s, over = {}) {
  const id = `pay_Fake${randomBytes(5).toString("hex")}`
  const answer = { id, entity: "payment", amount: s.total, currency: "INR", status: "captured", captured: true, order_id: s.providerOrderId, amount_refunded: 0, method: "upi", created_at: 1793000000, ...over }
  razorpay.payments.set(id, { answer })
  return id
}
/** The webhook event the inbox would hand over; its amount is what the webhook claimed, never used. */
const eventFor = (s, providerPaymentId, claimed = s.total) => ({
  provider: "razorpay",
  eventId: `evt${randomBytes(6).toString("hex")}`,
  fingerprint: `sha256:${randomBytes(32).toString("hex")}`,
  type: "payment.captured",
  providerOrderId: s.providerOrderId,
  providerPaymentId,
  providerRefundId: null,
  amount: { amountPaise: claimed, currency: "INR" },
  occurredAt: new Date().toISOString(),
})

/** Verify, then hand the bridge whatever the verdict allows: the path the inbox handler takes (Stage 14.12). */
async function settle(s, event) {
  const adapter = payments.paymentAdapterFor(process.env)
  const verdict = await verify.verifyCapture(ctx.db, adapter, event)
  const input = verify.captureInputFor(verdict, event, `test-${randomUUID()}`)
  const applied = input ? await capture.applyCapture(ctx.db, input) : null
  return { verdict, input, applied }
}

const stateOf = async s => {
  const [order, attempt, hold] = await Promise.all([
    ctx.db.order.findUniqueOrThrow({ where: { id: s.orderId }, select: { status: true } }),
    ctx.db.paymentAttempt.findUniqueOrThrow({ where: { id: s.attemptId }, select: { status: true, capturedAmountPaise: true, providerPaymentId: true } }),
    ctx.db.inventoryReservation.findUnique({ where: { orderId: s.orderId }, select: { status: true } }),
  ])
  return { order: order.status, payment: attempt.status, captured: attempt.capturedAmountPaise === null ? null : Number(attempt.capturedAmountPaise), paymentId: attempt.providerPaymentId, hold: hold?.status ?? null }
}

before(async () => {
  ctx = await setup("chaanavya_test_s14_verify_capture")
  forward = ctx.routes.me.GET
  owner = (await createStaff(ctx, "s14.verify.owner@example.com", "OWNER")).user
  await ctx.db.taxProfile.create({ data: { sellerStateCode: "IN-KA", pricesIncludeTax: true, note: "synthetic test values", createdById: owner.id, rates: { create: [{ taxCategory: "apparel_cotton", hsnCode: "6204", rateBasisPoints: 500 }] } } })
  Object.assign(process.env, SANDBOX)
  globalThis.fetch = stubFetch
  ;[verify, capture, payments, adapterModule, configModule] = await Promise.all([apiModule("payments/verify-capture"), apiModule("orders/capture"), apiModule("integrations/payments"), apiModule("integrations/razorpay/adapter"), apiModule("integrations/razorpay/config")])
})
after(() => {
  globalThis.fetch = realFetch
  for (const name of Object.keys(SANDBOX)) delete process.env[name]
  return ctx?.teardown()
})
beforeEach(() => {
  razorpay.calls.length = 0
  razorpay.down = 0
})

describe("CHV-S14-M11 a captured wrong amount cannot complete the order", () => {
  test("the order's exact total captured in INR is verified and completes the order: stock allocated, order confirmed", async () => {
    const s = await shopper()
    const pay = razorpayHolds(s)
    const { verdict, applied } = await settle(s, eventFor(s, pay))
    assert.deepEqual([verdict.kind, verdict.capturedAmountPaise, applied.outcome], ["verified", s.total, "confirmed"])
    assert.deepEqual(await stateOf(s), { order: "confirmed", payment: "captured", captured: s.total, paymentId: pay, hold: "allocated" })
    assert.ok(razorpay.calls.some(c => c.method === "GET" && c.path === `/v1/payments/${pay}`), "Razorpay itself was asked")
  })

  test("one paisa less, one paisa more, or half: the money is recorded, the order goes to review with its stock held, never confirmed", async () => {
    for (const delta of [-1, 1, "half"]) {
      const s = await shopper()
      const amount = delta === "half" ? Math.floor(s.total / 2) : s.total + delta
      const pay = razorpayHolds(s, { amount })
      // The webhook even claims the right amount; Razorpay's own answer is what counts.
      const { verdict, input, applied } = await settle(s, eventFor(s, pay, s.total))
      assert.deepEqual([verdict.kind, verdict.reason, input.capturedAmountPaise, applied.outcome], ["mismatch", "amount", amount, "needs_review"], String(delta))
      assert.deepEqual(await stateOf(s), { order: "needs_review", payment: "captured", captured: amount, paymentId: pay, hold: "active" }, String(delta))
    }
  })

  test("a webhook claiming a wrong amount does not matter: Razorpay's captured amount decides", async () => {
    const s = await shopper()
    const pay = razorpayHolds(s)
    const { verdict, input, applied } = await settle(s, eventFor(s, pay, 100))
    assert.deepEqual([verdict.kind, input.capturedAmountPaise, applied.outcome], ["verified", s.total, "confirmed"])
  })

  test("a capture Razorpay reports in another currency is never applied: the order, payment and stock stay as they were", async () => {
    const s = await shopper()
    const before = await stateOf(s)
    const pay = razorpayHolds(s, { currency: "USD" })
    const { verdict, input } = await settle(s, eventFor(s, pay))
    assert.deepEqual([verdict.kind, verdict.reason, input], ["rejected", "currency", null])
    assert.deepEqual(await stateOf(s), before)
  })

  test("another order's money, or another payment than the event names, is never applied to this order", async () => {
    const [mine, theirs] = [await shopper(), await shopper()]
    const before = await stateOf(mine)
    const theirPayment = razorpayHolds(theirs, { amount: mine.total })
    // An event for my Razorpay order naming their payment: Razorpay says it belongs to their order.
    const { verdict: crossed } = await settle(mine, eventFor(mine, theirPayment))
    assert.deepEqual([crossed.kind, crossed.reason], ["rejected", "order"])
    // Razorpay answering with another payment than the one asked about.
    const asked = razorpayHolds(mine)
    razorpay.payments.get(asked).answer = { ...razorpay.payments.get(asked).answer, id: `pay_Other${randomBytes(4).toString("hex")}` }
    const { verdict: swapped } = await settle(mine, eventFor(mine, asked))
    assert.deepEqual([swapped.kind, swapped.reason], ["rejected", "payment"])
    assert.deepEqual(await stateOf(mine), before)
  })

  test("authorized, failed, created or unknown to Razorpay is not a capture: nothing is applied", async () => {
    for (const over of [{ status: "authorized", captured: false }, { status: "failed", captured: false }, { status: "created", captured: false }, "missing"]) {
      const s = await shopper()
      const before = await stateOf(s)
      const pay = over === "missing" ? `pay_Missing${randomBytes(4).toString("hex")}` : razorpayHolds(s, over)
      const { verdict, input } = await settle(s, eventFor(s, pay))
      assert.deepEqual([verdict.kind, input], ["not_captured", null], JSON.stringify(over))
      assert.deepEqual(await stateOf(s), before, JSON.stringify(over))
    }
  })

  test("when Razorpay cannot be asked, nothing is decided: the error is retryable, and the retry completes the order once", async () => {
    const s = await shopper()
    const pay = razorpayHolds(s)
    const event = eventFor(s, pay)
    razorpay.down = 10
    await assert.rejects(settle(s, event), e => e.kind === "unavailable" && e.retryable === true)
    assert.equal((await stateOf(s)).order, "pending_payment")
    razorpay.down = 0
    assert.equal((await settle(s, event)).applied.outcome, "confirmed")
    assert.equal((await settle(s, event)).applied.outcome, "duplicate", "the same event again changes nothing")
  })

  test("five simultaneous deliveries of a mismatched capture leave one review, never a confirmation", async () => {
    const s = await shopper()
    const pay = razorpayHolds(s, { amount: s.total - 500 })
    const events = Array.from({ length: 5 }, () => eventFor(s, pay))
    const results = await Promise.all(events.map(e => settle(s, e)))
    assert.ok(results.every(r => r.verdict.kind === "mismatch"))
    assert.deepEqual(results.map(r => r.applied.outcome).sort(), ["already_applied", "already_applied", "already_applied", "already_applied", "needs_review"])
    assert.deepEqual(await stateOf(s), { order: "needs_review", payment: "captured", captured: s.total - 500, paymentId: pay, hold: "active" })
  })

  test("an event for a Razorpay order we never opened finds no attempt and asks Razorpay nothing", async () => {
    const adapter = payments.paymentAdapterFor(process.env)
    const verdict = await verify.verifyCapture(ctx.db, adapter, { provider: "razorpay", providerOrderId: "order_NeverOpened1", providerPaymentId: "pay_Fake1" })
    assert.deepEqual([verdict.kind, razorpay.calls.length], ["no_attempt", 0])
  })
})

describe("CHV-S14-M11 Razorpay's payment, read strictly", () => {
  const adapter = () => adapterModule.razorpayAdapter(configModule.loadRazorpayConfig({ APP_ENV: "development", ...SANDBOX }).config, stubFetch)

  test("a payment is read by id, or found by its order (the captured one first), in provider-neutral words", async () => {
    const s = { total: 249900, providerOrderId: `order_Lookup${randomBytes(4).toString("hex")}` }
    const failed = razorpayHolds(s, { status: "failed", captured: false, created_at: 1793000100 })
    const captured = razorpayHolds(s, { amount_refunded: 50000, created_at: 1793000000 })
    assert.deepEqual(await adapter().lookupPayment({ providerOrderId: s.providerOrderId, providerPaymentId: captured }), {
      providerOrderId: s.providerOrderId,
      providerPaymentId: captured,
      status: "partially_refunded",
      amount: { amountPaise: 249900, currency: "INR" },
      capturedAmount: { amountPaise: 249900, currency: "INR" },
      refundedAmount: { amountPaise: 50000, currency: "INR" },
      capturedAt: null,
      reportedCurrency: "INR",
    })
    assert.equal((await adapter().lookupPayment({ providerOrderId: s.providerOrderId, providerPaymentId: null })).providerPaymentId, captured, "the captured payment, though the failed one is newer")
    assert.equal((await adapter().captureStatus({ providerOrderId: s.providerOrderId, providerPaymentId: failed })).state, "failed")
    assert.equal((await adapter().captureStatus({ providerOrderId: s.providerOrderId, providerPaymentId: `pay_None${randomBytes(3).toString("hex")}` })).state, "not_captured")
  })

  test("an answer that is not a Razorpay payment is never believed, and a lookup is repeated after a 503", async () => {
    const s = { total: 189900, providerOrderId: `order_Strict${randomBytes(4).toString("hex")}` }
    for (const over of [{ amount: "189900" }, { amount: 1899.5 }, { amount: 0 }, { entity: "order" }, { captured: "yes" }, { order_id: "elsewhere" }, { id: "payment-1" }, { amount_refunded: -1 }]) {
      const pay = razorpayHolds(s, over)
      if (over.id) razorpay.payments.set("pay_BadId0001", razorpay.payments.get(pay))
      await assert.rejects(adapter().lookupPayment({ providerOrderId: s.providerOrderId, providerPaymentId: over.id ? "pay_BadId0001" : pay }), e => e.kind === "invalid_response", JSON.stringify(over))
    }
    const good = razorpayHolds(s)
    razorpay.down = 2
    razorpay.calls.length = 0
    assert.equal((await adapter().lookupPayment({ providerOrderId: s.providerOrderId, providerPaymentId: good })).status, "captured")
    assert.equal(razorpay.calls.length, 3, "two 503s, then the answer")
    await assert.rejects(adapter().lookupPayment({ providerOrderId: "not-an-order", providerPaymentId: good }), e => e.kind === "rejected")
    await assert.rejects(adapter().lookupPayment({ providerOrderId: s.providerOrderId, providerPaymentId: "../orders" }), e => e.kind === "rejected")
  })
})
