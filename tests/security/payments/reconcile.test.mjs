// CHV-S14-M14: a missing webhook eventually reconciles correctly. The payment reconciliation job
// (apps/worker/src/jobs/payment-reconciliation.ts, apps/api/src/payments/reconcile.ts) asks Razorpay about every
// attempt whose outcome we do not know and settles it through the checked payment code: a capture nobody told us
// about confirms its order once, a window that ended with only failed tries or no payment closes the attempt,
// money in progress is left, and the provider's limits and failures are respected and recorded. Orders are placed
// and checkouts opened through the web host's forwarder; Razorpay is a stand-in whose payments each test sets;
// the clock is moved forward instead of waiting; keys, ids and secrets are fake.
import { after, before, beforeEach, describe, test } from "node:test"
import assert from "node:assert/strict"
import { createHmac, randomBytes, randomUUID } from "node:crypto"
import { apiModule, call, createStaff, Jar, newIp, ORIGIN, setup } from "../auth/helpers.mjs"
import { orderExpiryJob } from "../../../apps/worker/src/jobs/order-expiry.ts"
import { paymentReconciliationJob } from "../../../apps/worker/src/jobs/payment-reconciliation.ts"

let ctx, forward, owner, reconcile, inbox, handlers, failures, cancel, payments
let n = 0

const SANDBOX = { PAYMENT_MODE: "test", RAZORPAY_KEY_ID: "rzp_test_FAKE0000000024", RAZORPAY_KEY_SECRET: "fake-key-secret-14-14-0001", RAZORPAY_WEBHOOK_SECRET: "fake-webhook-secret-14-14-0001" }
const cart = (method, path, { jar, body, headers = {} } = {}) => call(forward, `/api/cart${path}`, { method, jar, body, headers, ip: newIp() })
const address = { name: "Synthetic Buyer", phone: "+91 60000 00000", line1: "1 Example Road", line2: null, landmark: null, city: "Bengaluru", district: "Bengaluru Urban", stateCode: "IN-KA", pinCode: "560034" }
const MIN = 60_000

// ---- Razorpay stand-in --------------------------------------------------------------------------
const razorpay = { orders: [], payments: new Map(), down: false, lookups: 0 }
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
  razorpay.lookups += 1
  if (razorpay.down) return { status: 503, json: async () => ({ error: { code: "SERVER_ERROR" } }) }
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
    data: { handle: `fixture-rec-${n}`, title: `Fixture rec ${n}`, status: "active", publishedAt: new Date(), shippingRestriction: "none", variants: { create: [{ sku: `fixture-rec-${n}-m`, title: "M", optionKey: "size:m", pricePaise: 189900n, taxCategory: "apparel_cotton", weightGrams: 300 }] } },
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
  return { jar, orderId: placed.json.data.id, total: placed.json.data.grandTotal.amountPaise, variantId: p.variants[0].id, providerOrderId: opened.json.data.providerOrderId, attemptId: opened.json.data.attemptId }
}
function atRazorpay(s, status, over = {}) {
  const id = `pay_Fake${randomBytes(5).toString("hex")}`
  razorpay.payments.set(id, { id, entity: "payment", amount: s.total, currency: "INR", status, captured: status === "captured", order_id: s.providerOrderId, amount_refunded: 0, created_at: 1793000000 + razorpay.payments.size, ...over })
  return razorpay.payments.get(id)
}
async function webhook(payment, event = "payment.captured") {
  const bytes = Buffer.from(JSON.stringify({ entity: "event", event, payload: { payment: { entity: payment } }, created_at: 1793000000 }))
  const headers = new Headers({ "content-type": "application/json", "x-forwarded-for": "203.0.113.14", "x-razorpay-signature": createHmac("sha256", SANDBOX.RAZORPAY_WEBHOOK_SECRET).update(bytes).digest("hex"), "x-razorpay-event-id": `evt${randomBytes(8).toString("hex")}` })
  const response = await forward(new Request(`${ORIGIN}/api/webhooks/razorpay`, { method: "POST", headers, body: bytes }), { params: Promise.resolve({}) })
  assert.equal(response.status, 200)
}

const adapter = () => payments.paymentAdapterFor(process.env)
const at = minutes => new Date(Date.now() + minutes * MIN)
const run = (minutes, options = {}) => reconcile.reconcilePayments(ctx.db, adapter(), { now: at(minutes), ...options })
const inboxPass = () => inbox.processWebhookInbox(ctx.db, handlers.paymentEventsHandler(ctx.db, adapter(), failures.failureHandler(ctx.db, adapter())), { types: handlers.PAYMENT_EVENT_TYPES })
const recordOf = s => ctx.db.paymentReconciliation.findUnique({ where: { attemptId: s.attemptId } })

async function effects(s) {
  const [order, attempt, balance, confirms, paid] = await Promise.all([
    ctx.db.order.findUniqueOrThrow({ where: { id: s.orderId }, select: { status: true } }),
    ctx.db.paymentAttempt.findUniqueOrThrow({ where: { id: s.attemptId }, select: { status: true, capturedAmountPaise: true } }),
    ctx.db.inventoryBalance.findUniqueOrThrow({ where: { variantId: s.variantId }, select: { reserved: true, allocated: true } }),
    ctx.db.orderEvent.count({ where: { orderId: s.orderId, kind: "status", toState: "confirmed" } }),
    ctx.db.outboxEvent.count({ where: { topic: "order.paid", aggregateId: s.orderId } }),
  ])
  return { order: order.status, payment: attempt.status, captured: attempt.capturedAmountPaise === null ? null : Number(attempt.capturedAmountPaise), stock: balance, confirms, paid }
}
const confirmedOnce = s => ({ order: "confirmed", payment: "captured", captured: s.total, stock: { reserved: 0, allocated: 1 }, confirms: 1, paid: 1 })
const open = { order: "pending_payment", payment: "created", captured: null, stock: { reserved: 1, allocated: 0 }, confirms: 0, paid: 0 }

before(async () => {
  ctx = await setup("chaanavya_test_s14_payment_reconcile")
  forward = ctx.routes.me.GET
  owner = (await createStaff(ctx, "s14.rec.owner@example.com", "OWNER")).user
  await ctx.db.taxProfile.create({ data: { sellerStateCode: "IN-KA", pricesIncludeTax: true, note: "synthetic test values", createdById: owner.id, rates: { create: [{ taxCategory: "apparel_cotton", hsnCode: "6204", rateBasisPoints: 500 }] } } })
  Object.assign(process.env, SANDBOX)
  globalThis.fetch = stubFetch
  ;[reconcile, inbox, handlers, failures, cancel, payments] = await Promise.all(["payments/reconcile", "payments/inbox", "payments/capture-handler", "payments/failure-handler", "orders/cancel", "integrations/payments"].map(apiModule))
})
after(() => {
  globalThis.fetch = realFetch
  for (const name of Object.keys(SANDBOX)) delete process.env[name]
  return ctx?.teardown()
})
// Each test starts with nothing due from earlier tests: their open attempts are settled by Razorpay's word
// (no payment), a day ahead.
beforeEach(async () => {
  razorpay.down = false
  for (let i = 0; i < 20 && (await run(24 * 60, { limit: 500 })).checked > 0; i++) {
    /* settle */
  }
  razorpay.lookups = 0
})

describe("CHV-S14-M14 a capture nobody told us about is reconciled once", () => {
  test("the buyer paid and the webhook never came: after the quiet period the job confirms the order once", async () => {
    const s = await shopper()
    atRazorpay(s, "captured")
    assert.equal((await run(5)).checked, 0, "inside the quiet period nobody asks: a webhook may still come")
    assert.deepEqual(await effects(s), open)
    const result = await run(11)
    assert.deepEqual([result.checked, result.applied], [1, 1])
    assert.deepEqual(await effects(s), confirmedOnce(s))
    const rec = await recordOf(s)
    assert.deepEqual([rec.checks, rec.lastOutcome, rec.lastError], [1, "captured_applied", null])
    assert.equal(await ctx.db.providerEvent.count({ where: { eventId: { startsWith: "lookup:" }, summary: { path: ["paymentAttemptId"], equals: s.attemptId } } }), 1)
    assert.equal((await run(30)).checked, 0, "settled: not asked about again")
  })

  test("the late webhook for a payment the job already settled changes nothing; nor does a webhook-settled payment get asked about", async () => {
    const s = await shopper()
    const payment = atRazorpay(s, "captured")
    await run(11)
    await webhook(payment)
    await inboxPass()
    assert.deepEqual(await effects(s), confirmedOnce(s))

    const told = await shopper()
    await webhook(atRazorpay(told, "captured"))
    await inboxPass()
    razorpay.lookups = 0
    assert.equal((await run(11)).checked, 0)
    assert.equal(razorpay.lookups, 0, "Razorpay is not asked about what a webhook settled")
    assert.deepEqual(await effects(told), confirmedOnce(told))
  })

  test("two runs at the same moment, with the webhook arriving too, still confirm once", async () => {
    const s = await shopper()
    const payment = atRazorpay(s, "captured")
    await webhook(payment)
    await Promise.all([run(11), run(11), inboxPass()])
    assert.deepEqual(await effects(s), confirmedOnce(s))
  })

  test("a missing webhook for a wrong amount sends the order to review once, never confirmed", async () => {
    const s = await shopper()
    atRazorpay(s, "captured", { amount: s.total - 1 })
    await run(11)
    await run(40)
    const e = await effects(s)
    assert.deepEqual([e.order, e.payment, e.captured, e.stock, e.confirms, e.paid], ["needs_review", "captured", s.total - 1, { reserved: 1, allocated: 0 }, 0, 0])
  })

  test("a capture Razorpay reports in another currency is never applied and is noted for staff once over many runs", async () => {
    const s = await shopper()
    atRazorpay(s, "captured", { currency: "USD" })
    for (const minutes of [11, 14, 30, 60, 120]) await run(minutes)
    assert.deepEqual(await effects(s), open)
    assert.equal((await recordOf(s)).lastOutcome, "capture_rejected")
    assert.equal(await ctx.db.auditEvent.count({ where: { action: "payment.capture_rejected", entityId: s.attemptId } }), 1)
  })
})

describe("CHV-S14-M14 a window that ends is closed by Razorpay's word; money in progress is left", () => {
  test("only failed tries: still open while the window lasts, closed failed when it ends, then the order is cancelled and the stock released", async () => {
    const s = await shopper()
    atRazorpay(s, "failed")
    assert.equal(await recordOf(s), null)
    assert.equal((await run(11)).waiting, 1)
    assert.equal((await recordOf(s)).lastOutcome, "still_open")
    assert.equal((await run(12)).checked, 0, "not asked again before its wait")
    assert.equal((await run(16)).closed, 1)
    assert.equal((await effects(s)).payment, "failed")
    await orderExpiryJob(ctx.db, cancel.cancelUnpaidOrder, { clock: () => at(16) }).run()
    assert.deepEqual(await effects(s), { order: "cancelled", payment: "failed", captured: null, stock: { reserved: 0, allocated: 0 }, confirms: 0, paid: 0 })
  })

  test("no payment at all after the window: the expiry job holds the order, the job closes it expired, the expiry job cancels it", async () => {
    const s = await shopper()
    await orderExpiryJob(ctx.db, cancel.cancelUnpaidOrder, { clock: () => at(16) }).run()
    assert.equal((await effects(s)).payment, "pending_reconciliation")
    assert.equal((await run(16)).closed, 1)
    assert.deepEqual([(await effects(s)).payment, (await recordOf(s)).lastOutcome], ["expired", "closed_expired"])
    await orderExpiryJob(ctx.db, cancel.cancelUnpaidOrder, { clock: () => at(17) }).run()
    assert.equal((await effects(s)).order, "cancelled")
  })

  test("money authorized or in progress is never closed over, however late; it is asked about again with growing waits", async () => {
    const s = await shopper()
    atRazorpay(s, "authorized")
    await run(16)
    const first = await recordOf(s)
    assert.deepEqual([first.lastOutcome, (await effects(s)).payment], ["in_flight", "created"])
    assert.equal(first.nextCheckAt.getTime() - first.lastCheckedAt.getTime(), reconcile.CHECK_WAITS_MS[0])
    await run(19)
    const second = await recordOf(s)
    assert.equal(second.checks, 2)
    assert.equal(second.nextCheckAt.getTime() - second.lastCheckedAt.getTime(), reconcile.CHECK_WAITS_MS[1], "the wait grows")
    assert.deepEqual(await effects(s), open)
  })
})

describe("CHV-S14-M14 rate limits and recoverable errors", () => {
  test("at most a batch a run: twenty-five quiet checkouts are asked about over two runs, each once", async () => {
    const all = []
    for (let i = 0; i < 25; i++) {
      const s = await shopper()
      atRazorpay(s, "captured")
      all.push(s)
    }
    razorpay.lookups = 0
    const first = await run(11)
    assert.equal(first.checked, reconcile.RECONCILE_BATCH)
    const second = await run(11)
    assert.equal(second.checked, 25 - reconcile.RECONCILE_BATCH)
    for (const s of all) assert.deepEqual(await effects(s), confirmedOnce(s))
  })

  test("Razorpay down: the first failure stops the run, the error is kept, and the next run after the wait settles it", async () => {
    const [a, b] = [await shopper(), await shopper()]
    atRazorpay(a, "captured")
    atRazorpay(b, "captured")
    razorpay.down = true
    const failed = await run(11)
    assert.deepEqual([failed.checked, failed.errors, failed.stopped], [1, 1, 1], "stopped after the first failure")
    const records = (await Promise.all([recordOf(a), recordOf(b)])).filter(Boolean)
    assert.equal(records.length, 1)
    assert.equal(records[0].lastOutcome, "provider_unavailable")
    assert.match(records[0].lastError, /Razorpay answered 503/)
    razorpay.down = false
    await run(14)
    for (const s of [a, b]) assert.deepEqual(await effects(s), confirmedOnce(s))
  })

  test("the job: idle with payments off; with them on it reconciles on its clock", async () => {
    assert.deepEqual(await paymentReconciliationJob(ctx.db, reconcile.reconcilePayments, null).run(), { skipped: 1 })
    const s = await shopper()
    atRazorpay(s, "captured")
    const result = await paymentReconciliationJob(ctx.db, reconcile.reconcilePayments, adapter(), { clock: () => at(11) }).run()
    assert.equal(result.applied, 1)
    assert.deepEqual(await effects(s), confirmedOnce(s))
  })

  test("the record keeps its count and is never deleted", async () => {
    const s = await shopper()
    atRazorpay(s, "failed")
    await run(11)
    await assert.rejects(ctx.db.$executeRawUnsafe(`UPDATE "payment_reconciliation" SET "checks" = 0 WHERE "attempt_id" = '${s.attemptId}'`), /keeps its attempt/)
    await assert.rejects(ctx.db.$executeRawUnsafe(`DELETE FROM "payment_reconciliation" WHERE "attempt_id" = '${s.attemptId}'`), /are kept/)
    await assert.rejects(ctx.db.$executeRawUnsafe(`UPDATE "payment_reconciliation" SET "last_outcome" = 'paid' WHERE "attempt_id" = '${s.attemptId}'`), /outcome_known/)
  })
})
