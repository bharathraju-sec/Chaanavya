// CHV-S14-M13: a failed attempt does not create a paid order. Failed, shopper-cancelled and expired payments are
// told apart (apps/api/src/payments/failure-handler.ts, close-attempt.ts): a failed try is recorded and ends
// nothing, so the buyer can try again on the same checkout with the stock still held; an attempt ends only when
// its order is given up, as `failed` (only failed tries at Razorpay) or `expired` (no payment at all), and money
// in flight is never closed over. Orders are placed, checkouts opened and orders cancelled through the web
// host's forwarder; webhooks are signed and delivered through it; Razorpay is a stand-in whose payments each test
// sets; keys, ids and secrets are fake.
import { after, before, beforeEach, describe, test } from "node:test"
import assert from "node:assert/strict"
import { createHmac, randomBytes, randomUUID } from "node:crypto"
import { apiModule, call, createStaff, Jar, newIp, ORIGIN, setup } from "../auth/helpers.mjs"
import { orderExpiryJob } from "../../../apps/worker/src/jobs/order-expiry.ts"

let ctx, forward, owner, inbox, handlers, failures, closing, verify, capture, cancel, payments
let n = 0

const SANDBOX = { PAYMENT_MODE: "test", RAZORPAY_KEY_ID: "rzp_test_FAKE0000000023", RAZORPAY_KEY_SECRET: "fake-key-secret-14-13-0001", RAZORPAY_WEBHOOK_SECRET: "fake-webhook-secret-14-13-0001" }
const cart = (method, path, { jar, body, headers = {} } = {}) => call(forward, `/api/cart${path}`, { method, jar, body, headers, ip: newIp() })
const address = { name: "Synthetic Buyer", phone: "+91 60000 00000", line1: "1 Example Road", line2: null, landmark: null, city: "Bengaluru", district: "Bengaluru Urban", stateCode: "IN-KA", pinCode: "560034" }

// ---- Razorpay stand-in --------------------------------------------------------------------------
const razorpay = { orders: [], payments: new Map(), down: false }
const realFetch = globalThis.fetch
async function stubFetch(url, init) {
  if (!String(url).startsWith("https://api.razorpay.com/")) return realFetch(url, init)
  const { pathname, searchParams } = new URL(url)
  if (init.method === "POST" && pathname === "/v1/orders") {
    const body = JSON.parse(init.body)
    const order = { id: `order_Fake${razorpay.orders.length + 1}${randomBytes(3).toString("hex")}`, entity: "order", amount: body.amount, currency: body.currency, receipt: body.receipt, notes: body.notes, status: "created" }
    razorpay.orders.push(order)
    return { status: 200, json: async () => order }
  }
  if (pathname === "/v1/orders") return { status: 200, json: async () => ({ entity: "collection", items: razorpay.orders.filter(o => o.receipt === searchParams.get("receipt")) }) }
  if (razorpay.down) return { status: 503, json: async () => ({}) }
  const byOrder = pathname.match(/^\/v1\/orders\/(order_[A-Za-z0-9]+)\/payments$/)
  if (byOrder) return { status: 200, json: async () => ({ entity: "collection", items: [...razorpay.payments.values()].filter(p => p.order_id === byOrder[1]) }) }
  const byId = pathname.match(/^\/v1\/payments\/(pay_[A-Za-z0-9]+)$/)
  if (byId) {
    const p = razorpay.payments.get(byId[1])
    return p ? { status: 200, json: async () => p } : { status: 404, json: async () => ({ error: { code: "BAD_REQUEST_ERROR" } }) }
  }
  return { status: 404, json: async () => ({}) }
}

async function shopper({ open = true } = {}) {
  n += 1
  const p = await ctx.db.product.create({
    data: { handle: `fixture-fail-${n}`, title: `Fixture fail ${n}`, status: "active", publishedAt: new Date(), shippingRestriction: "none", variants: { create: [{ sku: `fixture-fail-${n}-m`, title: "M", optionKey: "size:m", pricePaise: 189900n, taxCategory: "apparel_cotton", weightGrams: 300 }] } },
    include: { variants: true },
  })
  await ctx.db.inventoryBalance.create({ data: { variantId: p.variants[0].id, onHand: 5, lastCountedAt: new Date() } })
  const jar = new Jar()
  assert.equal((await cart("POST", "/lines", { jar, body: { variantId: p.variants[0].id, quantity: 1 }, headers: { "idempotency-key": randomUUID() } })).status, 200)
  assert.equal((await cart("PUT", "/contact", { jar, body: { email: "buyer@example.com", shippingAddress: address } })).status, 200)
  const quote = (await cart("POST", "/quote", { jar, body: {} })).json.data
  const placed = await cart("POST", "/order", { jar, body: { quoteId: quote.id, expectedGrandTotal: quote.grandTotal }, headers: { "idempotency-key": randomUUID() } })
  assert.equal(placed.status, 201, JSON.stringify(placed.json))
  const s = { jar, orderId: placed.json.data.id, total: placed.json.data.grandTotal.amountPaise, variantId: p.variants[0].id }
  if (open) Object.assign(s, await openCheckout(s))
  return s
}
async function openCheckout(s) {
  const opened = await cart("POST", `/order/${s.orderId}/payment`, { jar: s.jar, body: {}, headers: { "idempotency-key": randomUUID() } })
  assert.equal(opened.status, 200, JSON.stringify(opened.json))
  return { providerOrderId: opened.json.data.providerOrderId, attemptId: opened.json.data.attemptId, reused: opened.json.reused }
}

/** A payment try at Razorpay on the shopper's Razorpay order. */
function tryAtRazorpay(s, status, over = {}) {
  const id = `pay_Fake${randomBytes(5).toString("hex")}`
  const captured = status === "captured"
  razorpay.payments.set(id, { id, entity: "payment", amount: s.total, currency: "INR", status, captured, order_id: s.providerOrderId, amount_refunded: 0, error_code: status === "failed" ? "BAD_REQUEST_ERROR" : null, created_at: 1793000000 + razorpay.payments.size, ...over })
  return razorpay.payments.get(id)
}
async function webhook(payment, event, eventId = `evt${randomBytes(8).toString("hex")}`) {
  const bytes = Buffer.from(JSON.stringify({ entity: "event", event, payload: { payment: { entity: payment } }, created_at: 1793000000 }))
  const headers = new Headers({ "content-type": "application/json", "x-forwarded-for": "203.0.113.13", "x-razorpay-signature": createHmac("sha256", SANDBOX.RAZORPAY_WEBHOOK_SECRET).update(bytes).digest("hex"), "x-razorpay-event-id": eventId })
  const response = await forward(new Request(`${ORIGIN}/api/webhooks/razorpay`, { method: "POST", headers, body: bytes }), { params: Promise.resolve({}) })
  assert.equal(response.status, 200, await response.clone().text())
  return eventId
}
const adapter = () => payments.paymentAdapterFor(process.env)
const pass = now => inbox.processWebhookInbox(ctx.db, handlers.paymentEventsHandler(ctx.db, adapter(), failures.failureHandler(ctx.db, adapter())), { types: handlers.PAYMENT_EVENT_TYPES, now })
const cancelOrder = s => cart("POST", `/order/${s.orderId}/cancel`, { jar: s.jar, body: {} })

async function stateOf(s) {
  const [order, attempts, balance, paid, tries] = await Promise.all([
    ctx.db.order.findUniqueOrThrow({ where: { id: s.orderId }, select: { status: true } }),
    ctx.db.paymentAttempt.findMany({ where: { orderId: s.orderId }, orderBy: { createdAt: "asc" }, select: { status: true, capturedAmountPaise: true } }),
    ctx.db.inventoryBalance.findUniqueOrThrow({ where: { variantId: s.variantId }, select: { reserved: true, allocated: true } }),
    ctx.db.outboxEvent.count({ where: { topic: "order.paid", aggregateId: s.orderId } }),
    ctx.db.auditEvent.count({ where: { action: "payment.try_failed", entityId: s.orderId } }),
  ])
  return { order: order.status, payments: attempts.map(a => a.status), captured: attempts.some(a => a.capturedAmountPaise !== null), stock: balance, paid, tries }
}

before(async () => {
  ctx = await setup("chaanavya_test_s14_failed_payments")
  forward = ctx.routes.me.GET
  owner = (await createStaff(ctx, "s14.fail.owner@example.com", "OWNER")).user
  await ctx.db.taxProfile.create({ data: { sellerStateCode: "IN-KA", pricesIncludeTax: true, note: "synthetic test values", createdById: owner.id, rates: { create: [{ taxCategory: "apparel_cotton", hsnCode: "6204", rateBasisPoints: 500 }] } } })
  Object.assign(process.env, SANDBOX)
  globalThis.fetch = stubFetch
  ;[inbox, handlers, failures, closing, verify, capture, cancel, payments] = await Promise.all(
    ["payments/inbox", "payments/capture-handler", "payments/failure-handler", "payments/close-attempt", "payments/verify-capture", "orders/capture", "orders/cancel", "integrations/payments"].map(apiModule),
  )
})
after(() => {
  globalThis.fetch = realFetch
  for (const name of Object.keys(SANDBOX)) delete process.env[name]
  return ctx?.teardown()
})
beforeEach(async () => {
  razorpay.down = false
  const later = new Date(Date.now() + 365 * 24 * 60 * 60_000)
  for (const e of await inbox.claimWebhookEvents(ctx.db, { now: later, limit: 1000 })) await inbox.completeWebhookEvent(ctx.db, e, later)
})

describe("CHV-S14-M13 a failed try is recorded, ends nothing, and never pays the order", () => {
  test("a verified payment.failed: recorded once for staff; the attempt stays open, the stock held, no order.paid; the retry reuses the checkout", async () => {
    const s = await shopper()
    const failed = tryAtRazorpay(s, "failed")
    const id = await webhook(failed, "payment.failed")
    await webhook(failed, "payment.failed", id)
    await Promise.all([pass(), pass()])
    assert.deepEqual(await stateOf(s), { order: "pending_payment", payments: ["created"], captured: false, stock: { reserved: 1, allocated: 0 }, paid: 0, tries: 1 })
    const again = await openCheckout(s)
    assert.deepEqual([again.attemptId, again.providerOrderId, again.reused], [s.attemptId, s.providerOrderId, true], "the same attempt and Razorpay order: the buyer just tries again")
  })

  test("failed twice, then the third try succeeds in the same window: the order is confirmed once", async () => {
    const s = await shopper()
    for (let i = 0; i < 2; i++) await webhook(tryAtRazorpay(s, "failed"), "payment.failed")
    await pass()
    await webhook(tryAtRazorpay(s, "captured"), "payment.captured")
    await pass()
    assert.deepEqual(await stateOf(s), { order: "confirmed", payments: ["captured"], captured: true, stock: { reserved: 0, allocated: 1 }, paid: 1, tries: 2 })
  })

  test("a payment.failed Razorpay does not hold as failed is not believed: a late success is left to the capture flow, an unknown payment ignored", async () => {
    const s = await shopper()
    const late = tryAtRazorpay(s, "captured")
    await webhook({ ...late, status: "failed", captured: false }, "payment.failed")
    await webhook({ ...late, id: "pay_NotAtRazorpay1", status: "failed", captured: false }, "payment.failed")
    await pass()
    assert.deepEqual(await stateOf(s), { order: "pending_payment", payments: ["created"], captured: false, stock: { reserved: 1, allocated: 0 }, paid: 0, tries: 0 })
  })
})

describe("CHV-S14-M13 a shopper cancelling is told apart from a failure, by what Razorpay says", () => {
  test("after only failed tries: the attempt ends failed, the order is cancelled, the stock released; paying again is refused", async () => {
    const s = await shopper()
    tryAtRazorpay(s, "failed")
    tryAtRazorpay(s, "failed")
    const res = await cancelOrder(s)
    assert.deepEqual([res.status, res.json.outcome], [200, "cancelled"])
    assert.deepEqual(await stateOf(s), { order: "cancelled", payments: ["failed"], captured: false, stock: { reserved: 0, allocated: 0 }, paid: 0, tries: 0 })
    const reasons = await ctx.db.auditEvent.findMany({ where: { action: "payment.transition", entityId: s.attemptId }, select: { reason: true, actorKind: true } })
    assert.deepEqual(reasons, [{ reason: "provider_reports_failed", actorKind: "provider" }])
    assert.equal((await cart("POST", `/order/${s.orderId}/payment`, { jar: s.jar, body: {}, headers: { "idempotency-key": randomUUID() } })).status, 409)
    assert.deepEqual((await cancelOrder(s)).json.outcome, "noop", "cancelling again changes nothing")
  })

  test("with a checkout opened but no payment at Razorpay: the attempt ends expired; with no checkout at all, as before", async () => {
    const s = await shopper()
    assert.equal((await cancelOrder(s)).json.outcome, "cancelled")
    assert.deepEqual((await stateOf(s)).payments, ["expired"])
    const reasons = await ctx.db.auditEvent.findMany({ where: { action: "payment.transition", entityId: s.attemptId }, select: { reason: true, actorKind: true } })
    assert.deepEqual(reasons, [{ reason: "session_ttl_passed_without_payment", actorKind: "system" }])
    const never = await shopper({ open: false })
    assert.equal((await cancelOrder(never)).json.outcome, "cancelled")
    assert.deepEqual((await stateOf(never)).payments, [])
  })

  test("money captured, authorized or still in progress at Razorpay is never closed over: the order stays pending, the stock held", async () => {
    for (const status of ["captured", "authorized", "created"]) {
      const s = await shopper()
      tryAtRazorpay(s, "failed", { created_at: 1793009999 })
      tryAtRazorpay(s, status, { created_at: 1793000001 })
      const res = await cancelOrder(s)
      assert.deepEqual([res.status, res.json.outcome], [200, "awaiting_payment_outcome"], status)
      assert.deepEqual(await stateOf(s), { order: "pending_payment", payments: ["created"], captured: false, stock: { reserved: 1, allocated: 0 }, paid: 0, tries: 0 }, status)
    }
  })

  test("when Razorpay cannot be asked, nothing is cancelled (502); asking again later works", async () => {
    const s = await shopper()
    tryAtRazorpay(s, "failed")
    razorpay.down = true
    const res = await cancelOrder(s)
    assert.deepEqual([res.status, res.json.error.code], [502, "unavailable"])
    assert.deepEqual((await stateOf(s)).order, "pending_payment")
    razorpay.down = false
    assert.equal((await cancelOrder(s)).json.outcome, "cancelled")
  })

  test("another shopper cannot close or cancel my attempt", async () => {
    const [mine, theirs] = [await shopper(), await shopper()]
    tryAtRazorpay(mine, "failed")
    const res = await cart("POST", `/order/${mine.orderId}/cancel`, { jar: theirs.jar, body: {} })
    assert.equal(res.status, 404)
    assert.deepEqual((await stateOf(mine)).payments, ["created"])
  })
})

describe("CHV-S14-M13 an expired window, and money arriving too late", () => {
  test("the payment window ends: the expiry job holds the order for reconciliation, closing it by Razorpay's word cancels it", async () => {
    const s = await shopper()
    const after = new Date(Date.now() + 24 * 60 * 60_000)
    const job = orderExpiryJob(ctx.db, cancel.cancelUnpaidOrder, { clock: () => after })
    assert.equal((await job.run()).awaiting >= 1, true)
    assert.deepEqual((await stateOf(s)).payments, ["pending_reconciliation"])
    assert.equal(await closing.closeOpenAttempt(ctx.db, adapter(), s.attemptId, { reason: "payment_window_ended", correlationId: "test-window" }), "expired")
    await job.run()
    assert.deepEqual(await stateOf(s), { order: "cancelled", payments: ["expired"], captured: false, stock: { reserved: 0, allocated: 0 }, paid: 0, tries: 0 })
  })

  test("a payment that succeeds after its attempt was closed failed never pays the cancelled order", async () => {
    const s = await shopper()
    tryAtRazorpay(s, "failed")
    assert.equal((await cancelOrder(s)).json.outcome, "cancelled")
    // The buyer pays in another tab at the last moment: Razorpay captures it.
    const late = tryAtRazorpay(s, "captured")
    const event = { provider: "razorpay", eventId: `evt${randomBytes(6).toString("hex")}`, fingerprint: `sha256:${randomBytes(32).toString("hex")}`, type: "payment.captured", providerOrderId: s.providerOrderId, providerPaymentId: late.id, providerRefundId: null, amount: { amountPaise: s.total, currency: "INR" }, occurredAt: new Date().toISOString() }
    const verdict = await verify.verifyCapture(ctx.db, adapter(), event)
    const applied = await capture.applyCapture(ctx.db, verify.captureInputFor(verdict, event, "test-late"))
    assert.equal(applied.outcome, "conflict", "kept for reconciliation and a refund, never applied")
    assert.deepEqual(await stateOf(s), { order: "cancelled", payments: ["failed"], captured: false, stock: { reserved: 0, allocated: 0 }, paid: 0, tries: 0 })
  })

  test("closing is safe to repeat and to race: five at once close the attempt once", async () => {
    const s = await shopper()
    tryAtRazorpay(s, "failed")
    const outcomes = await Promise.all(Array.from({ length: 5 }, () => closing.closeOpenAttempt(ctx.db, adapter(), s.attemptId, { reason: "shopper_cancelled", correlationId: "test-race" })))
    assert.equal(outcomes.filter(o => o === "failed").length >= 1, true)
    assert.ok(outcomes.every(o => o === "failed" || o === "not_open"), outcomes.join())
    assert.equal(await ctx.db.auditEvent.count({ where: { action: "payment.transition", entityId: s.attemptId } }), 1)
  })
})
