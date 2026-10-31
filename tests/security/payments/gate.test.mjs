// CHV-S14-M17: the Stage 14 payment gate. Success, failure, timeout, replay, wrong amount and refund scenarios run
// together against one database, through the real paths: checkouts opened and orders cancelled through the web
// host's forwarder, Razorpay webhooks signed and delivered through it, the worker's inbox, reconciliation and
// expiry jobs, and staff refunds on the admin route with a two-factor session. After every scenario the whole
// shop is checked against the money, order and stock invariants:
//   stock  the Stage 09 reconciliation finds nothing: every balance agrees with the ledger and the holds;
//   order  a confirmed order has exactly one captured payment for exactly its total, recorded from a verified
//          provider event, its stock allocated, one confirmation and one order.paid; nothing else has either;
//   money  no payment is refunded past what was captured; a payment's status says how much was refunded;
//          our succeeded refunds are exactly the refunds Razorpay processed; no order is paid twice.
// Razorpay is a stand-in that keeps its orders, payments and refunds and can lose answers; keys, ids and
// secrets are fake. Tax values are synthetic test values; delivery is the sandbox courier.
import { after, afterEach, before, beforeEach, describe, test } from "node:test"
import assert from "node:assert/strict"
import { createHmac, randomBytes, randomUUID } from "node:crypto"
import { apiModule, call, Jar, newIp, ORIGIN, setup, staffWithMfa, withOrigin } from "../auth/helpers.mjs"
import { problemsOf, reconciliationQuery } from "../../../apps/worker/src/jobs/inventory-reconciliation.ts"
import { orderExpiryJob } from "../../../apps/worker/src/jobs/order-expiry.ts"
import { paymentInboxJob } from "../../../apps/worker/src/jobs/payment-inbox.ts"
import { paymentReconciliationJob } from "../../../apps/worker/src/jobs/payment-reconciliation.ts"

let ctx, forward, owner, inbox, handlers, failures, refunds, reconcile, cancel, ledger, payments, transitions
let n = 0

const SANDBOX = { PAYMENT_MODE: "test", RAZORPAY_KEY_ID: "rzp_test_FAKE0000000027", RAZORPAY_KEY_SECRET: "fake-key-secret-14-17-0001", RAZORPAY_WEBHOOK_SECRET: "fake-webhook-secret-14-17-0001" }
const cart = (method, path, { jar, body, headers = {} } = {}) => call(forward, `/api/cart${path}`, { method, jar, body, headers, ip: newIp() })
const address = { name: "Synthetic Buyer", phone: "+91 60000 00000", line1: "1 Example Road", line2: null, landmark: null, city: "Bengaluru", district: "Bengaluru Urban", stateCode: "IN-KA", pinCode: "560034" }
const MIN = 60_000
const at = minutes => new Date(Date.now() + minutes * MIN)

// ---- Razorpay stand-in ----------------------------------------------------------------------------
const razorpay = { orders: [], payments: new Map(), refunds: new Map(), loseNextOrder: false, lax: false }
const realFetch = globalThis.fetch
const timeout = () => new DOMException("The operation was aborted due to timeout", "TimeoutError")
async function stubFetch(url, init) {
  if (!String(url).startsWith("https://api.razorpay.com/")) return realFetch(url, init)
  const { pathname, searchParams } = new URL(url)
  if (init.method === "POST" && pathname === "/v1/orders") {
    const body = JSON.parse(init.body)
    const order = { id: `order_Fake${razorpay.orders.length + 1}${randomBytes(3).toString("hex")}`, entity: "order", amount: body.amount, currency: body.currency, receipt: body.receipt, notes: body.notes, status: "created" }
    razorpay.orders.push(order)
    if (razorpay.loseNextOrder) {
      razorpay.loseNextOrder = false
      throw timeout()
    }
    return { status: 200, json: async () => order }
  }
  if (pathname === "/v1/orders") return { status: 200, json: async () => ({ entity: "collection", items: razorpay.orders.filter(o => o.receipt === searchParams.get("receipt")) }) }
  const byOrder = pathname.match(/^\/v1\/orders\/(order_[A-Za-z0-9]+)\/payments$/)
  if (byOrder) return { status: 200, json: async () => ({ entity: "collection", items: [...razorpay.payments.values()].filter(p => p.order_id === byOrder[1]) }) }
  const refundOf = pathname.match(/^\/v1\/payments\/(pay_[A-Za-z0-9]+)\/refund$/)
  if (refundOf && init.method === "POST") {
    const p = razorpay.payments.get(refundOf[1])
    const body = JSON.parse(init.body)
    // `lax`: the stand-in does not check the balance itself, so only our own checks keep refunds within the payment.
    if (!razorpay.lax && body.amount > p.amount - p.amount_refunded) return { status: 400, json: async () => ({ error: { code: "BAD_REQUEST_ERROR" } }) }
    const r = { id: `rfnd_Fake${razorpay.refunds.size + 1}${randomBytes(3).toString("hex")}`, entity: "refund", amount: body.amount, currency: "INR", payment_id: p.id, notes: body.notes, status: "processed", created_at: 1793000000 }
    razorpay.refunds.set(r.id, r)
    p.amount_refunded += body.amount
    return { status: 200, json: async () => r }
  }
  const refundsOf = pathname.match(/^\/v1\/payments\/(pay_[A-Za-z0-9]+)\/refunds$/)
  if (refundsOf) return { status: 200, json: async () => ({ entity: "collection", items: [...razorpay.refunds.values()].filter(r => r.payment_id === refundsOf[1]) }) }
  const refundById = pathname.match(/^\/v1\/refunds\/(rfnd_[A-Za-z0-9]+)$/)
  if (refundById) return razorpay.refunds.has(refundById[1]) ? { status: 200, json: async () => razorpay.refunds.get(refundById[1]) } : { status: 404, json: async () => ({}) }
  const byId = pathname.match(/^\/v1\/payments\/(pay_[A-Za-z0-9]+)$/)
  if (byId) {
    const p = razorpay.payments.get(byId[1])
    return p ? { status: 200, json: async () => ({ ...p, status: p.status === "captured" && p.amount_refunded >= p.amount ? "refunded" : p.status }) } : { status: 404, json: async () => ({}) }
  }
  return { status: 404, json: async () => ({}) }
}

// ---- the shop ------------------------------------------------------------------------------------
/** A product whose stock was received through the Stage 09 ledger, so the books balance from the start. */
async function product(price = 189900n) {
  n += 1
  const p = await ctx.db.product.create({
    data: { handle: `fixture-p14-gate-${n}`, title: `Fixture gate ${n}`, status: "active", publishedAt: new Date(), shippingRestriction: "none", variants: { create: [{ sku: `fixture-p14-gate-${n}-m`, title: "M", optionKey: "size:m", pricePaise: price, taxCategory: "apparel_cotton", weightGrams: 300 }] } },
    include: { variants: true },
  })
  const variantId = p.variants[0].id
  await ctx.db.inventoryBalance.create({ data: { variantId, onHand: 0, lastCountedAt: new Date() } })
  await ctx.db.$transaction(tx => ledger.applyMovement(tx, { variantId, type: "receipt", quantity: 10, reason: "gate fixture stock", reasonCode: "receipt", actor: { kind: "staff", id: owner.user.id }, reference: { type: "adjustment", id: randomUUID() } }))
  return variantId
}

/** A shopper's placed order and, unless told not to, its Razorpay checkout. */
async function shopper({ open = true, price } = {}) {
  const variantId = await product(price)
  const jar = new Jar()
  assert.equal((await cart("POST", "/lines", { jar, body: { variantId, quantity: 1 }, headers: { "idempotency-key": randomUUID() } })).status, 200)
  assert.equal((await cart("PUT", "/contact", { jar, body: { email: "buyer@example.com", shippingAddress: address } })).status, 200)
  const quote = (await cart("POST", "/quote", { jar, body: {} })).json.data
  const placed = await cart("POST", "/order", { jar, body: { quoteId: quote.id, expectedGrandTotal: quote.grandTotal }, headers: { "idempotency-key": randomUUID() } })
  assert.equal(placed.status, 201, JSON.stringify(placed.json))
  const s = { jar, variantId, orderId: placed.json.data.id, total: placed.json.data.grandTotal.amountPaise }
  return open ? Object.assign(s, await checkout(s)) : s
}
async function checkout(s) {
  const res = await cart("POST", `/order/${s.orderId}/payment`, { jar: s.jar, body: {}, headers: { "idempotency-key": randomUUID() } })
  assert.equal(res.status, 200, JSON.stringify(res.json))
  return { providerOrderId: res.json.data.providerOrderId, attemptId: res.json.data.attemptId }
}
/** A payment try at Razorpay. */
function pays(providerOrderId, amount, status = "captured", over = {}) {
  const id = `pay_Fake${randomBytes(5).toString("hex")}`
  const p = { id, entity: "payment", amount, currency: "INR", status, captured: status === "captured", order_id: providerOrderId, amount_refunded: 0, created_at: 1793000000 + razorpay.payments.size, ...over }
  razorpay.payments.set(id, p)
  return p
}
/** Razorpay's webhook, signed and delivered through the web host. */
async function webhook(event, entities, eventId = `evt${randomBytes(8).toString("hex")}`) {
  const bytes = Buffer.from(JSON.stringify({ entity: "event", event, payload: entities, created_at: 1793000000 }))
  const headers = new Headers({ "content-type": "application/json", "x-forwarded-for": "203.0.113.17", "x-razorpay-signature": createHmac("sha256", SANDBOX.RAZORPAY_WEBHOOK_SECRET).update(bytes).digest("hex"), "x-razorpay-event-id": eventId })
  const res = await forward(new Request(`${ORIGIN}/api/webhooks/razorpay`, { method: "POST", headers, body: bytes }), { params: Promise.resolve({}) })
  assert.equal(res.status, 200, await res.clone().text())
  return eventId
}
const paymentEvent = (event, p, eventId) => webhook(event, { payment: { entity: p } }, eventId)

const adapter = () => payments.paymentAdapterFor(process.env)
const handler = () => handlers.paymentEventsHandler(ctx.db, adapter(), failures.failureHandler(ctx.db, adapter()), refunds.refundEventHandler(ctx.db, adapter()))
/** The worker's inbox job, on the database clock, or at a time a test steps to. */
const worker = now => (now ? inbox.processWebhookInbox(ctx.db, handler(), { types: handlers.PAYMENT_EVENT_TYPES, now }) : paymentInboxJob(ctx.db, inbox.processWebhookInbox, handler(), handlers.PAYMENT_EVENT_TYPES).run())
const reconciler = minutes => paymentReconciliationJob(ctx.db, reconcile.reconcilePayments, adapter(), { clock: () => at(minutes) }).run()
const expiry = minutes => orderExpiryJob(ctx.db, cancel.cancelUnpaidOrder, { clock: () => at(minutes) }).run()
const refund = (s, amountPaise, key = `gate-refund-${randomUUID()}`) => call(forward, `/api/admin/payments/${s.attemptId}/refunds`, { method: "POST", jar: owner.jar, body: { amountPaise, reason: "gate refund" }, headers: { "idempotency-key": key }, ip: newIp() })
const statusOf = async s => (await ctx.db.order.findUniqueOrThrow({ where: { id: s.orderId }, select: { status: true } })).status

// ---- the invariants -----------------------------------------------------------------------------
async function invariants() {
  const problems = []
  for (const row of await reconciliationQuery(ctx.db)) for (const p of problemsOf(row)) problems.push(`stock ${row.variant_id}: ${p}`)
  for (const b of await ctx.db.inventoryBalance.findMany()) if (b.onHand < b.reserved + b.allocated || b.reserved < 0 || b.allocated < 0) problems.push(`stock ${b.variantId}: on hand ${b.onHand}, reserved ${b.reserved}, allocated ${b.allocated}`)

  const orders = await ctx.db.order.findMany({ select: { id: true, status: true, fulfilmentStatus: true, grandTotalPaise: true, reservation: { select: { status: true } }, payments: { select: { id: true, status: true, capturedAmountPaise: true, providerPaymentId: true, refunds: { select: { status: true, amountPaise: true, providerRefundId: true } } } } } })
  const confirms = new Map((await ctx.db.orderEvent.groupBy({ by: ["orderId"], where: { kind: "status", toState: "confirmed" }, _count: true })).map(g => [g.orderId, g._count]))
  const paid = new Map((await ctx.db.outboxEvent.groupBy({ by: ["aggregateId"], where: { topic: "order.paid" }, _count: true })).map(g => [g.aggregateId, g._count]))
  const recorded = new Set((await ctx.db.providerEvent.findMany({ select: { summary: true } })).map(e => e.summary?.paymentAttemptId))
  for (const o of orders) {
    const capturedAttempts = o.payments.filter(a => a.capturedAmountPaise !== null)
    if (o.status === "confirmed" || o.status === "completed") {
      if (capturedAttempts.length !== 1) problems.push(`order ${o.id}: confirmed with ${capturedAttempts.length} captured payments`)
      const [a] = capturedAttempts
      if (a && a.capturedAmountPaise !== o.grandTotalPaise) problems.push(`order ${o.id}: confirmed for ${a.capturedAmountPaise} of ${o.grandTotalPaise}`)
      if (a && !recorded.has(a.id)) problems.push(`order ${o.id}: confirmed without a recorded provider event`)
      if (o.reservation?.status !== "allocated") problems.push(`order ${o.id}: confirmed with its stock ${o.reservation?.status}`)
      if (confirms.get(o.id) !== 1 || paid.get(o.id) !== 1) problems.push(`order ${o.id}: ${confirms.get(o.id) ?? 0} confirmations, ${paid.get(o.id) ?? 0} order.paid`)
    } else {
      if (confirms.has(o.id) || paid.has(o.id)) problems.push(`order ${o.id}: ${o.status} but announced as paid`)
      if (o.fulfilmentStatus !== "unfulfilled") problems.push(`order ${o.id}: ${o.status} but fulfilment ${o.fulfilmentStatus}`)
    }
    if (capturedAttempts.length > 1) problems.push(`order ${o.id}: paid ${capturedAttempts.length} times`)
    if (o.status === "pending_payment" && o.reservation && o.reservation.status !== "active") problems.push(`order ${o.id}: pending with its stock ${o.reservation.status}`)
    if (o.status === "cancelled" && o.reservation && o.reservation.status !== "released") problems.push(`order ${o.id}: cancelled with its stock ${o.reservation.status}`)
    if (o.status === "cancelled" && capturedAttempts.length > 0) problems.push(`order ${o.id}: cancelled with a captured payment applied`)
    for (const a of o.payments) {
      const done = a.refunds.filter(r => r.status === "succeeded").reduce((sum, r) => sum + r.amountPaise, 0n)
      const counted = a.refunds.filter(r => ["requested", "processing", "succeeded"].includes(r.status)).reduce((sum, r) => sum + r.amountPaise, 0n)
      if (a.refunds.length && a.capturedAmountPaise === null) problems.push(`payment ${a.id}: refunds without a capture`)
      if (a.capturedAmountPaise !== null && counted > a.capturedAmountPaise) problems.push(`payment ${a.id}: ${counted} refunded of ${a.capturedAmountPaise}`)
      const expected = a.capturedAmountPaise === null ? null : done === 0n ? "captured" : done >= a.capturedAmountPaise ? "refunded" : "partially_refunded"
      if (expected && a.status !== expected) problems.push(`payment ${a.id}: ${a.status} but ${done} of ${a.capturedAmountPaise} refunded`)
      if (a.providerPaymentId) {
        const atRazorpay = [...razorpay.refunds.values()].filter(r => r.payment_id === a.providerPaymentId && r.status === "processed").reduce((sum, r) => sum + r.amount, 0)
        if (BigInt(atRazorpay) !== done) problems.push(`payment ${a.id}: Razorpay refunded ${atRazorpay}, we record ${done}`)
      }
    }
  }
  return problems
}

before(async () => {
  ctx = await setup("chaanavya_test_s14_payment_gate")
  forward = ctx.routes.me.GET
  owner = await staffWithMfa(ctx, "s14.gate.owner@example.com", "OWNER")
  await ctx.db.taxProfile.create({ data: { sellerStateCode: "IN-KA", pricesIncludeTax: true, note: "synthetic test values", createdById: owner.user.id, rates: { create: [{ taxCategory: "apparel_cotton", hsnCode: "6204", rateBasisPoints: 500 }] } } })
  Object.assign(process.env, SANDBOX)
  globalThis.fetch = stubFetch
  ;[inbox, handlers, failures, refunds, reconcile, cancel, ledger, payments, transitions] = await Promise.all(
    ["payments/inbox", "payments/capture-handler", "payments/failure-handler", "payments/refund", "payments/reconcile", "orders/cancel", "inventory/ledger", "integrations/payments", "db/transitions"].map(apiModule),
  )
})
after(() => {
  globalThis.fetch = realFetch
  for (const name of Object.keys(SANDBOX)) delete process.env[name]
  return ctx?.teardown()
})
beforeEach(() => {
  razorpay.loseNextOrder = false
  razorpay.lax = false
})
afterEach(async () => {
  assert.deepEqual(await invariants(), [], "money, order and stock invariants after the scenario")
})

describe("CHV-S14-M17 success, failure and timeout", () => {
  test("success: paid, confirmed once, stock allocated", async () => {
    const s = await shopper()
    await paymentEvent("payment.captured", pays(s.providerOrderId, s.total))
    await worker()
    assert.equal(await statusOf(s), "confirmed")
  })

  test("failure: failed tries end nothing, a retry on the same checkout succeeds; a shopper who gives up gets the stock released", async () => {
    const paying = await shopper()
    await paymentEvent("payment.failed", pays(paying.providerOrderId, paying.total, "failed"))
    await paymentEvent("payment.failed", pays(paying.providerOrderId, paying.total, "failed"))
    await worker()
    assert.equal(await statusOf(paying), "pending_payment")
    await paymentEvent("payment.captured", pays(paying.providerOrderId, paying.total))
    await worker()
    assert.equal(await statusOf(paying), "confirmed")

    const givesUp = await shopper()
    await paymentEvent("payment.failed", pays(givesUp.providerOrderId, givesUp.total, "failed"))
    await worker()
    assert.equal((await cart("POST", `/order/${givesUp.orderId}/cancel`, { jar: givesUp.jar, body: {} })).json.outcome, "cancelled")
    assert.equal(await statusOf(givesUp), "cancelled")

    // Money still on its way at Razorpay: cancelling waits for it, the stock stays held.
    const inFlight = await shopper()
    pays(inFlight.providerOrderId, inFlight.total, "authorized", { created_at: 1793000001 })
    pays(inFlight.providerOrderId, inFlight.total, "failed", { created_at: 1793009999 })
    assert.equal((await cart("POST", `/order/${inFlight.orderId}/cancel`, { jar: inFlight.jar, body: {} })).json.outcome, "awaiting_payment_outcome")
    assert.equal(await statusOf(inFlight), "pending_payment")
  })

  test("timeout: Razorpay opens the order but the answer is lost; the checkout is still the one order, and paying it confirms once", async () => {
    const s = await shopper({ open: false })
    razorpay.loseNextOrder = true
    Object.assign(s, await checkout(s))
    assert.equal(razorpay.orders.filter(o => o.notes?.attempt_id === s.attemptId).length, 1)
    await paymentEvent("payment.captured", pays(s.providerOrderId, s.total))
    await worker()
    assert.equal(await statusOf(s), "confirmed")
  })

  test("expiry: a window that ends with no payment holds, reconciles to expired and cancels; the stock comes back", async () => {
    const s = await shopper()
    await expiry(16)
    await reconciler(16)
    await expiry(17)
    assert.equal(await statusOf(s), "cancelled")
  })
})

describe("CHV-S14-M17 replay", () => {
  test("the same webhook, new events for the same payment, and several workers at once confirm once", async () => {
    const s = await shopper()
    const p = pays(s.providerOrderId, s.total)
    const id = await paymentEvent("payment.captured", p)
    await paymentEvent("payment.captured", p, id)
    for (let i = 0; i < 3; i++) await paymentEvent("payment.captured", p)
    await Promise.all([worker(), worker(), worker()])
    assert.equal(await statusOf(s), "confirmed")
  })

  test("a missing webhook reconciled, then the late webhook, then the job again: confirmed once", async () => {
    const s = await shopper()
    const p = pays(s.providerOrderId, s.total)
    await reconciler(11)
    assert.equal(await statusOf(s), "confirmed")
    await paymentEvent("payment.captured", p)
    await worker()
    await reconciler(40)
  })

  test("a worker that dies after confirming: the event runs again and changes nothing", async () => {
    const s = await shopper()
    await paymentEvent("payment.captured", pays(s.providerOrderId, s.total))
    const [claimed] = await inbox.claimWebhookEvents(ctx.db, { types: handlers.PAYMENT_EVENT_TYPES, leaseMs: 1_000 })
    await handler()(claimed)
    await worker(new Date(Date.now() + 2_000))
    assert.equal(await statusOf(s), "confirmed")
  })

  test("a payment on an old tab's checkout after the order was paid on a new one is never applied", async () => {
    const s = await shopper()
    const first = { ...s }
    await paymentEvent("payment.failed", pays(s.providerOrderId, s.total, "failed"))
    await worker()
    // The first attempt ends as a verified provider event would end it; a new checkout replaces it (14.15).
    await withOrigin(ctx.db, tx => transitions.transitionPayment(tx, { paymentAttemptId: s.attemptId, from: "created", to: "failed", facts: {}, actor: { kind: "provider", id: "razorpay" }, correlationId: "gate-end" }))
    Object.assign(s, await checkout(s))
    await paymentEvent("payment.captured", pays(s.providerOrderId, s.total))
    await worker()
    await paymentEvent("payment.captured", pays(first.providerOrderId, s.total))
    await worker()
    assert.equal(await statusOf(s), "confirmed")
  })
})

describe("CHV-S14-M17 wrong amounts and refunds", () => {
  test("a wrong captured amount, by webhook or by reconciliation, goes to review with the stock held, never confirmed", async () => {
    const byWebhook = await shopper()
    await paymentEvent("payment.captured", pays(byWebhook.providerOrderId, byWebhook.total - 1))
    await worker()
    const byJob = await shopper()
    pays(byJob.providerOrderId, byJob.total + 100)
    await reconciler(11)
    assert.deepEqual([await statusOf(byWebhook), await statusOf(byJob)], ["needs_review", "needs_review"])
  })

  test("refunds: partial then the rest, a race of five, and one over the paid amount; never past what was captured", async () => {
    const s = await shopper()
    await paymentEvent("payment.captured", pays(s.providerOrderId, s.total))
    await worker()
    razorpay.lax = true
    assert.equal((await refund(s, 50000)).status, 200)
    assert.equal((await refund(s, s.total - 50000 + 1)).status, 409)
    await ctx.db.$executeRawUnsafe(`CREATE FUNCTION test_gate_slow_refund() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.3); RETURN NEW; END; $$`)
    await ctx.db.$executeRawUnsafe(`CREATE TRIGGER test_gate_slow_refund BEFORE INSERT ON "refund" FOR EACH ROW EXECUTE FUNCTION test_gate_slow_refund()`)
    let race
    try {
      race = await Promise.all(Array.from({ length: 5 }, () => refund(s, s.total - 50000)))
    } finally {
      await ctx.db.$executeRawUnsafe(`DROP TRIGGER test_gate_slow_refund ON "refund"`)
      await ctx.db.$executeRawUnsafe(`DROP FUNCTION test_gate_slow_refund()`)
    }
    assert.deepEqual(race.map(r => r.status).sort(), [200, 409, 409, 409, 409])
    assert.equal((await refund(s, 100)).status, 409)
  })

  test("a refund webhook replayed and a refund retried with its key change nothing", async () => {
    const s = await shopper()
    await paymentEvent("payment.captured", pays(s.providerOrderId, s.total))
    await worker()
    const first = await refund(s, 30000, "gate-refund-key-0001")
    assert.equal((await refund(s, 30000, "gate-refund-key-0001")).json.created, false)
    const r = razorpay.refunds.get(first.json.data.providerRefundId)
    const payment = razorpay.payments.get(r.payment_id)
    for (let i = 0; i < 3; i++) await webhook("refund.processed", { payment: { entity: payment }, refund: { entity: r } })
    await worker()
    assert.equal(await ctx.db.refund.count({ where: { paymentAttemptId: s.attemptId } }), 1)
  })
})

describe("CHV-S14-M17 everything at once", () => {
  test("eight orders with mixed outcomes, their events delivered twice in shuffled order, three workers and the jobs racing", async () => {
    const shoppers = await Promise.all(Array.from({ length: 8 }, () => shopper()))
    const plans = ["paid", "paid", "failed_then_paid", "wrong_amount", "failed", "missing_webhook", "paid", "nothing"]
    const deliveries = []
    shoppers.forEach((s, i) => {
      const plan = plans[i]
      if (plan === "failed" || plan === "failed_then_paid") deliveries.push(["payment.failed", pays(s.providerOrderId, s.total, "failed")])
      if (plan === "paid" || plan === "failed_then_paid") deliveries.push(["payment.captured", pays(s.providerOrderId, s.total)])
      if (plan === "wrong_amount") deliveries.push(["payment.captured", pays(s.providerOrderId, s.total - 250)])
      if (plan === "missing_webhook") pays(s.providerOrderId, s.total)
    })
    const twice = [...deliveries, ...deliveries].map(d => ({ d, k: Math.random() })).sort((a, b) => a.k - b.k).map(x => x.d)
    await Promise.all(twice.map(([event, p]) => paymentEvent(event, p)))
    await Promise.all([worker(), worker(), worker(), reconciler(11)])
    await worker()
    const statuses = await Promise.all(shoppers.map(statusOf))
    assert.deepEqual(statuses, ["confirmed", "confirmed", "confirmed", "needs_review", "pending_payment", "confirmed", "confirmed", "pending_payment"])
  })
})
