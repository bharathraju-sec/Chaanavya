// CHV-S14-M15: retrying cannot cause a double charge or a double fulfilment. Paying again
// (POST /api/cart/order/:orderId/payment, apps/api/src/payments/start.ts) returns the attempt in progress while
// there is one, refuses while its outcome is unknown, and opens a new attempt only once Razorpay confirms nothing
// was paid, authorized or is in progress on the ended ones. Whatever reaches Razorpay anyway (an old tab paid at
// the last moment) is never applied a second time: the order is confirmed and its stock allocated once. Orders
// are placed and checkouts opened through the web host's forwarder; Razorpay is a stand-in whose payments each test
// sets; an ended attempt is made by a provider-origin transition, as a verified provider event would; keys, ids
// and secrets are fake.
import { after, before, beforeEach, describe, test } from "node:test"
import assert from "node:assert/strict"
import { randomBytes, randomUUID } from "node:crypto"
import { apiModule, call, createStaff, Jar, newIp, setup, withOrigin } from "../auth/helpers.mjs"

let ctx, forward, owner, verify, capture, transitions, payments
let n = 0

const SANDBOX = { PAYMENT_MODE: "test", RAZORPAY_KEY_ID: "rzp_test_FAKE0000000025", RAZORPAY_KEY_SECRET: "fake-key-secret-14-15-0001", RAZORPAY_WEBHOOK_SECRET: "fake-webhook-secret-14-15-0001" }
const cart = (method, path, { jar, body, headers = {} } = {}) => call(forward, `/api/cart${path}`, { method, jar, body, headers, ip: newIp() })
const address = { name: "Synthetic Buyer", phone: "+91 60000 00000", line1: "1 Example Road", line2: null, landmark: null, city: "Bengaluru", district: "Bengaluru Urban", stateCode: "IN-KA", pinCode: "560034" }

// ---- Razorpay stand-in --------------------------------------------------------------------------
const razorpay = { orders: [], payments: new Map(), down: false, created: 0 }
const realFetch = globalThis.fetch
async function stubFetch(url, init) {
  if (!String(url).startsWith("https://api.razorpay.com/")) return realFetch(url, init)
  const { pathname, searchParams } = new URL(url)
  if (init.method === "POST" && pathname === "/v1/orders") {
    razorpay.created += 1
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

async function shopper() {
  n += 1
  const p = await ctx.db.product.create({
    data: { handle: `fixture-retry-flow-${n}`, title: `Fixture retry flow ${n}`, status: "active", publishedAt: new Date(), shippingRestriction: "none", variants: { create: [{ sku: `fixture-retry-flow-${n}-m`, title: "M", optionKey: "size:m", pricePaise: 189900n, taxCategory: "apparel_cotton", weightGrams: 300 }] } },
    include: { variants: true },
  })
  await ctx.db.inventoryBalance.create({ data: { variantId: p.variants[0].id, onHand: 5, lastCountedAt: new Date() } })
  const jar = new Jar()
  assert.equal((await cart("POST", "/lines", { jar, body: { variantId: p.variants[0].id, quantity: 1 }, headers: { "idempotency-key": randomUUID() } })).status, 200)
  assert.equal((await cart("PUT", "/contact", { jar, body: { email: "buyer@example.com", shippingAddress: address } })).status, 200)
  const quote = (await cart("POST", "/quote", { jar, body: {} })).json.data
  const placed = await cart("POST", "/order", { jar, body: { quoteId: quote.id, expectedGrandTotal: quote.grandTotal }, headers: { "idempotency-key": randomUUID() } })
  assert.equal(placed.status, 201, JSON.stringify(placed.json))
  return { jar, orderId: placed.json.data.id, total: placed.json.data.grandTotal.amountPaise, variantId: p.variants[0].id }
}
const pay = (s, key = `retry-${randomUUID()}`) => cart("POST", `/order/${s.orderId}/payment`, { jar: s.jar, body: {}, headers: { "idempotency-key": key } })
function atRazorpay(providerOrderId, total, status, over = {}) {
  const id = `pay_Fake${randomBytes(5).toString("hex")}`
  razorpay.payments.set(id, { id, entity: "payment", amount: total, currency: "INR", status, captured: status === "captured", order_id: providerOrderId, amount_refunded: 0, created_at: 1793000000 + razorpay.payments.size, ...over })
  return razorpay.payments.get(id)
}
/** The attempt ended as a verified provider event would end it. */
const endAttempt = (attemptId, to = "failed") => withOrigin(ctx.db, tx => transitions.transitionPayment(tx, { paymentAttemptId: attemptId, from: "created", to, facts: {}, actor: to === "failed" ? { kind: "provider", id: "razorpay" } : { kind: "system", id: null }, correlationId: `test-end-${randomUUID()}` }))
const markAttempt = (attemptId, status) => withOrigin(ctx.db, tx => tx.paymentAttempt.update({ where: { id: attemptId }, data: { status } }))

/** Razorpay captures a payment and the capture is settled as a webhook or the reconciliation job would. */
async function settleCapture(providerOrderId, payment) {
  const adapter = payments.paymentAdapterFor(process.env)
  const event = { provider: "razorpay", eventId: `evt${randomBytes(6).toString("hex")}`, fingerprint: `sha256:${randomBytes(32).toString("hex")}`, type: "payment.captured", providerOrderId, providerPaymentId: payment.id, providerRefundId: null, amount: { amountPaise: payment.amount, currency: "INR" }, occurredAt: new Date().toISOString() }
  const verdict = await verify.verifyCapture(ctx.db, adapter, event)
  const input = verify.captureInputFor(verdict, event, `test-${randomUUID()}`)
  return input ? (await capture.applyCapture(ctx.db, input)).outcome : verdict.kind
}

async function ledger(s) {
  const [order, attempts, balance, confirms, paid] = await Promise.all([
    ctx.db.order.findUniqueOrThrow({ where: { id: s.orderId }, select: { status: true, fulfilmentStatus: true } }),
    ctx.db.paymentAttempt.findMany({ where: { orderId: s.orderId }, orderBy: { createdAt: "asc" }, select: { status: true, capturedAmountPaise: true } }),
    ctx.db.inventoryBalance.findUniqueOrThrow({ where: { variantId: s.variantId }, select: { reserved: true, allocated: true } }),
    ctx.db.orderEvent.count({ where: { orderId: s.orderId, kind: "status", toState: "confirmed" } }),
    ctx.db.outboxEvent.count({ where: { topic: "order.paid", aggregateId: s.orderId } }),
  ])
  return { order: order.status, fulfilment: order.fulfilmentStatus, attempts: attempts.map(a => a.status), capturedTimes: attempts.filter(a => a.capturedAmountPaise !== null).length, stock: balance, confirms, paid }
}

before(async () => {
  ctx = await setup("chaanavya_test_s14_payment_retry")
  forward = ctx.routes.me.GET
  owner = (await createStaff(ctx, "s14.retryflow.owner@example.com", "OWNER")).user
  await ctx.db.taxProfile.create({ data: { sellerStateCode: "IN-KA", pricesIncludeTax: true, note: "synthetic test values", createdById: owner.id, rates: { create: [{ taxCategory: "apparel_cotton", hsnCode: "6204", rateBasisPoints: 500 }] } } })
  Object.assign(process.env, SANDBOX)
  globalThis.fetch = stubFetch
  ;[verify, capture, transitions, payments] = await Promise.all(["payments/verify-capture", "orders/capture", "db/transitions", "integrations/payments"].map(apiModule))
})
after(() => {
  globalThis.fetch = realFetch
  for (const name of Object.keys(SANDBOX)) delete process.env[name]
  return ctx?.teardown()
})
beforeEach(() => {
  razorpay.down = false
})

describe("CHV-S14-M15 while an attempt is in progress, retrying never opens another", () => {
  test("retries with the same key, a new key, and ten at once all get the one attempt and the one Razorpay order", async () => {
    const s = await shopper()
    const first = await pay(s, "retry-same-key-0001")
    const results = [await pay(s, "retry-same-key-0001"), await pay(s), ...(await Promise.all(Array.from({ length: 10 }, () => pay(s))))]
    assert.ok(results.every(r => r.status === 200 && r.json.data.attemptId === first.json.data.attemptId && r.json.data.providerOrderId === first.json.data.providerOrderId))
    assert.deepEqual((await ledger(s)).attempts, ["created"])
  })

  test("an outcome still unknown (being reconciled) or money authorized: retrying is refused, nothing new is opened", async () => {
    for (const status of ["pending_reconciliation", "authorized"]) {
      const s = await shopper()
      const first = await pay(s)
      await markAttempt(first.json.data.attemptId, status)
      const createdBefore = razorpay.created
      const again = await pay(s)
      assert.deepEqual([again.status, again.json.error.fields?.payment], [409, status], status)
      assert.deepEqual([(await ledger(s)).attempts, razorpay.created], [[status], createdBefore], status)
    }
  })
})

describe("CHV-S14-M15 a new attempt replaces an ended one only when Razorpay confirms it is safe", () => {
  test("only failed tries on the ended checkout: a new attempt and checkout are opened, and paying it confirms the order once", async () => {
    const s = await shopper()
    const first = (await pay(s)).json.data
    atRazorpay(first.providerOrderId, s.total, "failed")
    await endAttempt(first.attemptId)
    const retried = await pay(s)
    assert.equal(retried.status, 200, JSON.stringify(retried.json))
    assert.notEqual(retried.json.data.attemptId, first.attemptId)
    assert.notEqual(retried.json.data.providerOrderId, first.providerOrderId)
    assert.equal(await settleCapture(retried.json.data.providerOrderId, atRazorpay(retried.json.data.providerOrderId, s.total, "captured")), "confirmed")
    assert.deepEqual(await ledger(s), { order: "confirmed", fulfilment: "unfulfilled", attempts: ["failed", "captured"], capturedTimes: 1, stock: { reserved: 0, allocated: 1 }, confirms: 1, paid: 1 })
  })

  test("an ended checkout that was paid anyway (late success, old tab): the retry is refused, nothing new is opened, staff are told once", async () => {
    for (const status of ["captured", "authorized", "created"]) {
      const s = await shopper()
      const first = (await pay(s)).json.data
      atRazorpay(first.providerOrderId, s.total, "failed", { created_at: 1793009999 })
      atRazorpay(first.providerOrderId, s.total, status)
      await endAttempt(first.attemptId)
      const createdBefore = razorpay.created
      const results = [await pay(s), await pay(s)]
      for (const r of results) assert.deepEqual([r.status, r.json.error.fields?.payment], [409, "earlier_attempt_unsettled"], status)
      assert.deepEqual([(await ledger(s)).attempts, razorpay.created], [["failed"], createdBefore], `${status}: no second checkout that could be paid`)
      assert.equal(await ctx.db.auditEvent.count({ where: { action: "payment.retry_blocked", entityId: s.orderId } }), 1, status)
    }
  })

  test("every ended checkout is asked about, not only the latest: an older one paid late refuses the retry", async () => {
    const s = await shopper()
    const first = (await pay(s)).json.data
    atRazorpay(first.providerOrderId, s.total, "failed")
    await endAttempt(first.attemptId)
    const second = (await pay(s)).json.data
    await endAttempt(second.attemptId, "expired")
    // The first checkout, ended long ago, is paid in an old tab.
    atRazorpay(first.providerOrderId, s.total, "captured")
    const createdBefore = razorpay.created
    const third = await pay(s)
    assert.deepEqual([third.status, third.json.error.fields?.payment], [409, "earlier_attempt_unsettled"])
    assert.deepEqual([(await ledger(s)).attempts, razorpay.created], [["failed", "expired"], createdBefore])
  })

  test("Razorpay cannot be asked about the ended checkout: the retry is refused (502) and nothing new is opened; later it works", async () => {
    const s = await shopper()
    const first = (await pay(s)).json.data
    await endAttempt(first.attemptId, "expired")
    razorpay.down = true
    const refused = await pay(s)
    assert.deepEqual([refused.status, refused.json.error.code], [502, "unavailable"])
    assert.deepEqual((await ledger(s)).attempts, ["expired"])
    razorpay.down = false
    assert.equal((await pay(s)).status, 200, "nothing at Razorpay: the new attempt is safe")
    assert.deepEqual((await ledger(s)).attempts, ["expired", "created"])
  })

  test("five simultaneous retries after an ended attempt open exactly one new attempt", async () => {
    const s = await shopper()
    const first = (await pay(s)).json.data
    atRazorpay(first.providerOrderId, s.total, "failed")
    await endAttempt(first.attemptId)
    const results = await Promise.all(Array.from({ length: 5 }, () => pay(s)))
    assert.ok(results.every(r => r.status === 200))
    assert.equal(new Set(results.map(r => r.json.data.attemptId)).size, 1)
    assert.deepEqual((await ledger(s)).attempts, ["failed", "created"])
  })
})

describe("CHV-S14-M15 money that reaches Razorpay twice is never applied twice", () => {
  test("paid on the new attempt and on the old tab: confirmed and allocated once; the second payment is kept for a refund", async () => {
    const s = await shopper()
    const first = (await pay(s)).json.data
    atRazorpay(first.providerOrderId, s.total, "failed")
    await endAttempt(first.attemptId)
    const second = (await pay(s)).json.data
    assert.equal(await settleCapture(second.providerOrderId, atRazorpay(second.providerOrderId, s.total, "captured")), "confirmed")
    // The old tab's checkout is paid at the last moment.
    assert.equal(await settleCapture(first.providerOrderId, atRazorpay(first.providerOrderId, s.total, "captured")), "conflict")
    assert.deepEqual(await ledger(s), { order: "confirmed", fulfilment: "unfulfilled", attempts: ["failed", "captured"], capturedTimes: 1, stock: { reserved: 0, allocated: 1 }, confirms: 1, paid: 1 })
  })

  test("after the order is paid, paying again is refused and opens nothing; replays of the capture change nothing", async () => {
    const s = await shopper()
    const first = (await pay(s)).json.data
    const payment = atRazorpay(first.providerOrderId, s.total, "captured")
    assert.equal(await settleCapture(first.providerOrderId, payment), "confirmed")
    const createdBefore = razorpay.created
    const again = await pay(s)
    assert.equal(again.status, 409)
    assert.equal(razorpay.created, createdBefore)
    assert.equal(await settleCapture(first.providerOrderId, payment), "already_applied")
    assert.deepEqual(await ledger(s), { order: "confirmed", fulfilment: "unfulfilled", attempts: ["captured"], capturedTimes: 1, stock: { reserved: 0, allocated: 1 }, confirms: 1, paid: 1 })
  })
})
