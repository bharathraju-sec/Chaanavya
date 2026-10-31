// CHV-S14-M12: a crash or a replay cannot confirm an order twice. From a signed payment.captured webhook to a
// confirmed order: the inbox keeps the event (14.10), the worker job claims it (apps/worker/src/jobs/payment-inbox.ts),
// the capture handler (apps/api/src/payments/capture-handler.ts) checks it with Razorpay (14.11), and the capture
// bridge (apps/api/src/orders/capture.ts) records the event once, captures the payment, allocates the stock,
// confirms the order and writes one order.paid outbox event, all in one transaction. Crashes are simulated where
// they can happen: inside that transaction (a failing write), and after it commits but before the inbox marks the
// event done (a claim that is never finished). Orders are placed and checkouts opened through the web host's
// forwarder; Razorpay is a stand-in whose payments the test sets; keys, ids and secrets are fake.
import { after, before, beforeEach, describe, test } from "node:test"
import assert from "node:assert/strict"
import { createHmac, randomBytes, randomUUID } from "node:crypto"
import { apiModule, call, createStaff, Jar, newIp, ORIGIN, setup } from "../auth/helpers.mjs"
import { paymentInboxJob } from "../../../apps/worker/src/jobs/payment-inbox.ts"
import { outboxJob } from "../../../apps/worker/src/jobs/outbox.ts"

let ctx, forward, owner, inbox, handlerModule, payments, logger
let n = 0

const SANDBOX = { PAYMENT_MODE: "test", RAZORPAY_KEY_ID: "rzp_test_FAKE0000000022", RAZORPAY_KEY_SECRET: "fake-key-secret-14-12-0001", RAZORPAY_WEBHOOK_SECRET: "fake-webhook-secret-14-12-0001" }
const cart = (method, path, { jar, body, headers = {} } = {}) => call(forward, `/api/cart${path}`, { method, jar, body, headers, ip: newIp() })
const address = { name: "Synthetic Buyer", phone: "+91 60000 00000", line1: "1 Example Road", line2: null, landmark: null, city: "Bengaluru", district: "Bengaluru Urban", stateCode: "IN-KA", pinCode: "560034" }

// ---- Razorpay stand-in: orders for the checkout, payments set by each test ---------------------------
const razorpay = { orders: [], payments: new Map(), lookups: 0 }
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
  const byId = pathname.match(/^\/v1\/payments\/(pay_[A-Za-z0-9]+)$/)
  if (byId) {
    razorpay.lookups += 1
    const p = razorpay.payments.get(byId[1])
    return p ? { status: 200, json: async () => p } : { status: 404, json: async () => ({ error: { code: "BAD_REQUEST_ERROR" } }) }
  }
  return { status: 404, json: async () => ({}) }
}

async function shopper() {
  n += 1
  const p = await ctx.db.product.create({
    data: { handle: `fixture-p2o-${n}`, title: `Fixture p2o ${n}`, status: "active", publishedAt: new Date(), shippingRestriction: "none", variants: { create: [{ sku: `fixture-p2o-${n}-m`, title: "M", optionKey: "size:m", pricePaise: 189900n, taxCategory: "apparel_cotton", weightGrams: 300 }] } },
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

/** Razorpay captures the payment (its own record) and sends a signed payment.captured webhook through the web host. */
function captureAtRazorpay(s, over = {}) {
  const id = `pay_Fake${randomBytes(5).toString("hex")}`
  const payment = { id, entity: "payment", amount: s.total, currency: "INR", status: "captured", captured: true, order_id: s.providerOrderId, amount_refunded: 0, created_at: 1793000000, ...over }
  razorpay.payments.set(id, payment)
  return payment
}
async function webhook(payment, { event = "payment.captured", eventId = `evt${randomBytes(8).toString("hex")}` } = {}) {
  const bytes = Buffer.from(JSON.stringify({ entity: "event", event, payload: { payment: { entity: { ...payment, amount: payment.amount } } }, created_at: 1793000000 }))
  const headers = new Headers({ "content-type": "application/json", "x-forwarded-for": "203.0.113.12", "x-razorpay-signature": createHmac("sha256", SANDBOX.RAZORPAY_WEBHOOK_SECRET).update(bytes).digest("hex"), "x-razorpay-event-id": eventId })
  const response = await forward(new Request(`${ORIGIN}/api/webhooks/razorpay`, { method: "POST", headers, body: bytes }), { params: Promise.resolve({}) })
  assert.equal(response.status, 200, await response.clone().text())
  return { eventId, inbox: (await response.json()).event?.inbox }
}

const handler = () => handlerModule.captureHandler(ctx.db, payments.paymentAdapterFor(process.env))
const job = () => paymentInboxJob(ctx.db, inbox.processWebhookInbox, handler(), handlerModule.CAPTURE_EVENT_TYPES)
/** One worker pass, on the database clock; `now` lets a test step past retry waits and claim leases. */
const pass = now => inbox.processWebhookInbox(ctx.db, handler(), { types: handlerModule.CAPTURE_EVENT_TYPES, now })

/** Everything a confirmation touches, counted. Each must be exactly once for one order. */
async function effects(s) {
  const [order, attempt, balance, confirms, paidEvents, recorded, allocations] = await Promise.all([
    ctx.db.order.findUniqueOrThrow({ where: { id: s.orderId }, select: { status: true } }),
    ctx.db.paymentAttempt.findUniqueOrThrow({ where: { id: s.attemptId }, select: { status: true, capturedAmountPaise: true } }),
    ctx.db.inventoryBalance.findUniqueOrThrow({ where: { variantId: s.variantId }, select: { onHand: true, reserved: true, allocated: true } }),
    ctx.db.orderEvent.count({ where: { orderId: s.orderId, kind: "status", toState: "confirmed" } }),
    ctx.db.outboxEvent.count({ where: { topic: "order.paid", aggregateId: s.orderId } }),
    ctx.db.providerEvent.count({ where: { summary: { path: ["paymentAttemptId"], equals: s.attemptId } } }),
    ctx.db.inventoryMovement.count({ where: { variantId: s.variantId, type: "allocation" } }),
  ])
  return { order: order.status, payment: attempt.status, captured: attempt.capturedAmountPaise === null ? null : Number(attempt.capturedAmountPaise), stock: balance, confirms, paidEvents, recorded, allocations }
}
const confirmedOnce = s => ({ order: "confirmed", payment: "captured", captured: s.total, stock: { onHand: 5, reserved: 0, allocated: 1 }, confirms: 1, paidEvents: 1, recorded: 1, allocations: 1 })
const untouched = { order: "pending_payment", payment: "created", captured: null, stock: { onHand: 5, reserved: 1, allocated: 0 }, confirms: 0, paidEvents: 0, recorded: 0, allocations: 0 }

before(async () => {
  ctx = await setup("chaanavya_test_s14_payment_to_order")
  forward = ctx.routes.me.GET
  owner = (await createStaff(ctx, "s14.p2o.owner@example.com", "OWNER")).user
  await ctx.db.taxProfile.create({ data: { sellerStateCode: "IN-KA", pricesIncludeTax: true, note: "synthetic test values", createdById: owner.id, rates: { create: [{ taxCategory: "apparel_cotton", hsnCode: "6204", rateBasisPoints: 500 }] } } })
  Object.assign(process.env, SANDBOX)
  globalThis.fetch = stubFetch
  ;[inbox, handlerModule, payments] = await Promise.all([apiModule("payments/inbox"), apiModule("payments/capture-handler"), apiModule("integrations/payments")])
  const { createLogger } = await import("@chaanavya/shared/observability/logger")
  logger = createLogger({ base: { service: "test" } })
})
after(() => {
  globalThis.fetch = realFetch
  for (const name of Object.keys(SANDBOX)) delete process.env[name]
  return ctx?.teardown()
})
// Each test starts with no captured-payment event due: earlier tests' events are worked off first.
beforeEach(async () => {
  const later = new Date(Date.now() + 365 * 24 * 60 * 60_000)
  for (const e of await inbox.claimWebhookEvents(ctx.db, { now: later, limit: 1000 })) await inbox.completeWebhookEvent(ctx.db, e, later)
})

describe("CHV-S14-M12 a captured payment confirms its order once, in one transaction", () => {
  test("webhook, inbox, worker job: payment captured, stock allocated, order confirmed and one order.paid event, all together", async () => {
    const s = await shopper()
    assert.deepEqual(await effects(s), untouched)
    const { eventId, inbox: kept } = await webhook(captureAtRazorpay(s))
    assert.equal(kept, "stored")
    assert.deepEqual(await effects(s), untouched, "the webhook alone changes nothing")
    const result = await job().run()
    assert.equal(result.processed, 1)
    assert.deepEqual(await effects(s), confirmedOnce(s))
    assert.equal((await ctx.db.paymentWebhookInbox.findFirstOrThrow({ where: { eventId } })).status, "processed")
    const [paid] = await ctx.db.outboxEvent.findMany({ where: { topic: "order.paid", aggregateId: s.orderId } })
    assert.deepEqual(paid.payload, { orderId: s.orderId, orderNumber: (await ctx.db.order.findUniqueOrThrow({ where: { id: s.orderId } })).number, paymentAttemptId: s.attemptId, capturedAmountPaise: s.total, currency: "INR" })
  })

  test("a crash inside the transaction (the last write fails) leaves nothing half done; the retry confirms once", async () => {
    const s = await shopper()
    await webhook(captureAtRazorpay(s))
    await ctx.db.$executeRawUnsafe(`CREATE FUNCTION test_crash_at_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.topic = 'order.paid' THEN RAISE EXCEPTION 'the process died'; END IF; RETURN NEW; END; $$`)
    await ctx.db.$executeRawUnsafe(`CREATE TRIGGER test_crash_at_outbox BEFORE INSERT ON "outbox_event" FOR EACH ROW EXECUTE FUNCTION test_crash_at_outbox()`)
    let crashed
    try {
      crashed = await pass()
    } finally {
      await ctx.db.$executeRawUnsafe(`DROP TRIGGER test_crash_at_outbox ON "outbox_event"`)
      await ctx.db.$executeRawUnsafe(`DROP FUNCTION test_crash_at_outbox()`)
    }
    assert.equal(crashed.retrying, 1)
    assert.deepEqual(await effects(s), untouched, "payment, stock, order, event record and outbox all rolled back together")
    const retried = await pass(new Date(Date.now() + inbox.RETRY_WAITS_MS[0] + 1_000))
    assert.equal(retried.processed, 1)
    assert.deepEqual(await effects(s), confirmedOnce(s))
  })

  test("a crash at commit, after every write was made, leaves no order.paid and no stock moved; the retry confirms once", async () => {
    const s = await shopper()
    await webhook(captureAtRazorpay(s))
    // A deferred check on the order fails only when the transaction commits: everything was written by then.
    await ctx.db.$executeRawUnsafe(`CREATE FUNCTION test_crash_at_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'the process died at commit'; END; $$`)
    await ctx.db.$executeRawUnsafe(`CREATE CONSTRAINT TRIGGER test_crash_at_commit AFTER UPDATE ON "order" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.status = 'confirmed') EXECUTE FUNCTION test_crash_at_commit()`)
    let crashed
    try {
      crashed = await pass()
    } finally {
      await ctx.db.$executeRawUnsafe(`DROP TRIGGER test_crash_at_commit ON "order"`)
      await ctx.db.$executeRawUnsafe(`DROP FUNCTION test_crash_at_commit()`)
    }
    assert.equal(crashed.retrying, 1)
    assert.deepEqual(await effects(s), untouched, "nothing committed: no order.paid announced for an order that was not confirmed")
    assert.equal((await pass(new Date(Date.now() + inbox.RETRY_WAITS_MS[0] + 1_000))).processed, 1)
    assert.deepEqual(await effects(s), confirmedOnce(s))
  })

  test("a crash after the transaction commits but before the inbox hears of it: the event runs again and changes nothing", async () => {
    const s = await shopper()
    const { eventId } = await webhook(captureAtRazorpay(s))
    // A worker claims the event and confirms the order, then dies before marking the event done.
    const [claimed] = await inbox.claimWebhookEvents(ctx.db, { types: handlerModule.CAPTURE_EVENT_TYPES, leaseMs: 1_000 })
    await handler()(claimed)
    assert.deepEqual(await effects(s), confirmedOnce(s))
    assert.equal((await ctx.db.paymentWebhookInbox.findFirstOrThrow({ where: { eventId } })).status, "processing")
    // Another worker takes the lapsed claim and runs it again.
    const again = await pass(new Date(Date.now() + 2_000))
    assert.equal(again.processed, 1)
    assert.deepEqual(await effects(s), confirmedOnce(s), "no second confirmation, allocation or order.paid")
    const done = await ctx.db.paymentWebhookInbox.findFirstOrThrow({ where: { eventId } })
    assert.deepEqual([done.status, done.attempts], ["processed", 2])
    assert.equal(await inbox.completeWebhookEvent(ctx.db, claimed), false, "the dead worker's claim is void")
  })

  test("replays: the same webhook again, a new event for the same payment, and both at once with two workers confirm once", async () => {
    const s = await shopper()
    const payment = captureAtRazorpay(s)
    const first = await webhook(payment)
    await pass()
    assert.equal((await webhook(payment, { eventId: first.eventId })).inbox, "duplicate")
    // Razorpay sends payment.captured more than once, under new event ids.
    for (let i = 0; i < 3; i++) await webhook(payment)
    await Promise.all([pass(), pass(), pass()])
    // Four distinct events, each recorded once (provider_event is unique per event id); one confirmation.
    assert.deepEqual(await effects(s), { ...confirmedOnce(s), recorded: 4 })

    const raced = await shopper()
    const racedPayment = captureAtRazorpay(raced)
    for (let i = 0; i < 6; i++) await webhook(racedPayment)
    await Promise.all([pass(), pass(), pass()])
    assert.deepEqual(await effects(raced), { ...confirmedOnce(raced), recorded: 6 })
  })

  test("a wrong captured amount is recorded and sent to review once; replays never confirm it", async () => {
    const s = await shopper()
    const payment = captureAtRazorpay(s, { amount: s.total - 1 })
    await webhook(payment)
    await webhook(payment)
    await pass()
    const after = await effects(s)
    assert.deepEqual([after.order, after.payment, after.captured, after.stock, after.confirms, after.paidEvents], ["needs_review", "captured", s.total - 1, { onHand: 5, reserved: 1, allocated: 0 }, 0, 0])
  })
})

describe("CHV-S14-M12 what the worker does not confirm", () => {
  test("Razorpay not yet showing the capture: retried, then confirmed once it does", async () => {
    const s = await shopper()
    const payment = captureAtRazorpay(s, { status: "authorized", captured: false })
    await webhook({ ...payment, status: "captured", captured: true })
    assert.equal((await pass()).retrying, 1)
    assert.deepEqual(await effects(s), untouched)
    razorpay.payments.set(payment.id, { ...payment, status: "captured", captured: true })
    assert.equal((await pass(new Date(Date.now() + inbox.RETRY_WAITS_MS[0] + 1_000))).processed, 1)
    assert.deepEqual(await effects(s), confirmedOnce(s))
  })

  test("another currency is never applied, and is noted for staff once however often it runs", async () => {
    const s = await shopper()
    // The webhook claims INR (a USD webhook is refused at the door, 14.09); Razorpay's own record says USD.
    const atRazorpay = captureAtRazorpay(s, { currency: "USD" })
    const { eventId } = await webhook({ ...atRazorpay, currency: "INR" })
    const [claimed] = await inbox.claimWebhookEvents(ctx.db, { types: handlerModule.CAPTURE_EVENT_TYPES, leaseMs: 1_000 })
    await handler()(claimed)
    await pass(new Date(Date.now() + 2_000))
    assert.deepEqual(await effects(s), untouched)
    const inboxRow = await ctx.db.paymentWebhookInbox.findFirstOrThrow({ where: { eventId } })
    assert.equal(await ctx.db.auditEvent.count({ where: { action: "payment.capture_rejected", correlationId: `inbox:${inboxRow.id}` } }), 1)
    assert.equal(inboxRow.status, "processed")
  })

  test("events this handler does not act on wait in the inbox; with payments off the job does nothing", async () => {
    const s = await shopper()
    const { eventId } = await webhook(captureAtRazorpay(s, { status: "failed", captured: false }), { event: "payment.failed" })
    await job().run()
    assert.equal((await ctx.db.paymentWebhookInbox.findFirstOrThrow({ where: { eventId } })).status, "received", "kept for the failed-payment step (14.13)")
    assert.deepEqual(await paymentInboxJob(ctx.db, inbox.processWebhookInbox, null, handlerModule.CAPTURE_EVENT_TYPES).run(), { skipped: 1 })
    assert.deepEqual(await effects(s), untouched)
  })

  test("the order.paid event is delivered by the outbox job (logged until notifications exist)", async () => {
    const s = await shopper()
    await webhook(captureAtRazorpay(s))
    await pass()
    await ctx.db.$transaction(tx => outboxJob(logger).run(tx))
    const [paid] = await ctx.db.outboxEvent.findMany({ where: { topic: "order.paid", aggregateId: s.orderId } })
    assert.ok(paid.dispatchedAt, "delivered")
    assert.equal(paid.lastError, null)
  })
})
