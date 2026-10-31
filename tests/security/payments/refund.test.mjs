// CHV-S14-M16: a refund needs permission and the correct paid amount. POST /api/admin/payments/:attemptId/refunds
// (apps/api/src/modules/refund-admin.controller.ts, apps/api/src/payments/refund.ts, the Razorpay adapter's refund
// and lookupRefund) refunds part or all of a captured payment: refunds.approve and a two-factor staff session, the
// approver's limit, and never more than is still refundable by Razorpay's own record; Razorpay's refund id and
// status are recorded, and its refund webhooks finish what was pending. Orders are placed, paid (through the 13.10
// capture bridge, as a verified capture is) and refunded through the web host's forwarder; Razorpay is a stand-in
// that keeps its payments and refunds; keys, ids and secrets are fake.
import { after, before, beforeEach, describe, test } from "node:test"
import assert from "node:assert/strict"
import { createHmac, randomBytes, randomUUID } from "node:crypto"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { ROOT } from "../../integration/database/helpers.mjs"
import { apiModule, call, createStaff, Jar, newIp, ORIGIN, setup, signInCustomer, staffWithMfa } from "../auth/helpers.mjs"

let ctx, forward, owner, admin, staffer, plain, customer, verify, capture, inbox, handlers, failures, refunds, payments
let n = 0

const SANDBOX = { PAYMENT_MODE: "test", RAZORPAY_KEY_ID: "rzp_test_FAKE0000000026", RAZORPAY_KEY_SECRET: "fake-key-secret-14-16-0001", RAZORPAY_WEBHOOK_SECRET: "fake-webhook-secret-14-16-0001" }
const cart = (method, path, { jar, body, headers = {} } = {}) => call(forward, `/api/cart${path}`, { method, jar, body, headers, ip: newIp() })
const address = { name: "Synthetic Buyer", phone: "+91 60000 00000", line1: "1 Example Road", line2: null, landmark: null, city: "Bengaluru", district: "Bengaluru Urban", stateCode: "IN-KA", pinCode: "560034" }

// ---- Razorpay stand-in: orders, payments and refunds --------------------------------------------
const razorpay = { orders: [], payments: new Map(), refunds: new Map(), mode: "processed", calls: [], listsDown: 0, lax: false, refuseConnection: false }
const realFetch = globalThis.fetch
const lost = () => new DOMException("The operation was aborted due to timeout", "TimeoutError")
async function stubFetch(url, init) {
  if (!String(url).startsWith("https://api.razorpay.com/")) return realFetch(url, init)
  const { pathname, searchParams } = new URL(url)
  razorpay.calls.push(`${init.method} ${pathname}`)
  if (init.method === "POST" && pathname === "/v1/orders") {
    const body = JSON.parse(init.body)
    const order = { id: `order_Fake${razorpay.orders.length + 1}${randomBytes(3).toString("hex")}`, entity: "order", amount: body.amount, currency: body.currency, receipt: body.receipt, notes: body.notes, status: "created" }
    razorpay.orders.push(order)
    return { status: 200, json: async () => order }
  }
  if (pathname === "/v1/orders") return { status: 200, json: async () => ({ entity: "collection", items: razorpay.orders.filter(o => o.receipt === searchParams.get("receipt")) }) }
  const refundOf = pathname.match(/^\/v1\/payments\/(pay_[A-Za-z0-9]+)\/refund$/)
  if (refundOf && init.method === "POST") {
    const payment = razorpay.payments.get(refundOf[1])
    const body = JSON.parse(init.body)
    if (razorpay.refuseConnection) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } })
    // `lax`: the stand-in does not check the balance itself, so only our own checks stand between a request and an over-refund.
    if (razorpay.mode === "reject" || (!razorpay.lax && body.amount > payment.amount - payment.amount_refunded)) return { status: 400, json: async () => ({ error: { code: "BAD_REQUEST_ERROR", description: "The refund amount provided is greater than amount captured" } }) }
    const status = razorpay.mode === "pending" ? "pending" : "processed"
    const refund = { id: `rfnd_Fake${razorpay.refunds.size + 1}${randomBytes(3).toString("hex")}`, entity: "refund", amount: body.amount, currency: "INR", payment_id: payment.id, notes: body.notes, status, created_at: 1793000000 }
    razorpay.refunds.set(refund.id, refund)
    payment.amount_refunded += body.amount
    if (razorpay.mode === "lose_answer") throw lost()
    if (razorpay.mode === "lose_answer_and_lookups") {
      razorpay.mode = "lost"
      throw lost()
    }
    return { status: 200, json: async () => refund }
  }
  const refundsOf = pathname.match(/^\/v1\/payments\/(pay_[A-Za-z0-9]+)\/refunds$/)
  if (refundsOf) {
    // After a lost answer, the refund lists can be made to fail for a while too.
    if (razorpay.listsDown > 0 && razorpay.calls.filter(c => c.startsWith("POST") && c.endsWith("/refund")).length > 0 && razorpay.mode === "lost") {
      razorpay.listsDown -= 1
      return { status: 503, json: async () => ({}) }
    }
    return { status: 200, json: async () => ({ entity: "collection", items: [...razorpay.refunds.values()].filter(r => r.payment_id === refundsOf[1]) }) }
  }
  const refundById = pathname.match(/^\/v1\/refunds\/(rfnd_[A-Za-z0-9]+)$/)
  if (refundById) {
    const r = razorpay.refunds.get(refundById[1])
    return r ? { status: 200, json: async () => r } : { status: 404, json: async () => ({}) }
  }
  const byId = pathname.match(/^\/v1\/payments\/(pay_[A-Za-z0-9]+)$/)
  if (byId) {
    const p = razorpay.payments.get(byId[1])
    return p ? { status: 200, json: async () => ({ ...p, status: p.amount_refunded >= p.amount ? "refunded" : "captured" }) } : { status: 404, json: async () => ({}) }
  }
  return { status: 404, json: async () => ({}) }
}

/** A paid order: placed, its checkout opened, captured at Razorpay and settled. */
async function paidOrder(pricePaise = 189900n, { pay = true } = {}) {
  n += 1
  const p = await ctx.db.product.create({
    data: { handle: `fixture-refund-${n}`, title: `Fixture refund ${n}`, status: "active", publishedAt: new Date(), shippingRestriction: "none", variants: { create: [{ sku: `fixture-refund-${n}-m`, title: "M", optionKey: "size:m", pricePaise, taxCategory: "apparel_cotton", weightGrams: 300 }] } },
    include: { variants: true },
  })
  await ctx.db.inventoryBalance.create({ data: { variantId: p.variants[0].id, onHand: 5, lastCountedAt: new Date() } })
  const jar = new Jar()
  assert.equal((await cart("POST", "/lines", { jar, body: { variantId: p.variants[0].id, quantity: 1 }, headers: { "idempotency-key": randomUUID() } })).status, 200)
  assert.equal((await cart("PUT", "/contact", { jar, body: { email: "buyer@example.com", shippingAddress: address } })).status, 200)
  const quote = (await cart("POST", "/quote", { jar, body: {} })).json.data
  const placed = await cart("POST", "/order", { jar, body: { quoteId: quote.id, expectedGrandTotal: quote.grandTotal }, headers: { "idempotency-key": randomUUID() } })
  assert.equal(placed.status, 201, JSON.stringify(placed.json))
  const opened = (await cart("POST", `/order/${placed.json.data.id}/payment`, { jar, body: {}, headers: { "idempotency-key": randomUUID() } })).json.data
  const total = placed.json.data.grandTotal.amountPaise
  if (!pay) return { orderId: placed.json.data.id, attemptId: opened.attemptId, total, shopperJar: jar }
  const payment = { id: `pay_Fake${randomBytes(5).toString("hex")}`, entity: "payment", amount: total, currency: "INR", status: "captured", captured: true, order_id: opened.providerOrderId, amount_refunded: 0, created_at: 1793000000 }
  razorpay.payments.set(payment.id, payment)
  const event = { provider: "razorpay", eventId: `evt${randomBytes(6).toString("hex")}`, fingerprint: `sha256:${randomBytes(32).toString("hex")}`, type: "payment.captured", providerOrderId: opened.providerOrderId, providerPaymentId: payment.id, providerRefundId: null, amount: { amountPaise: total, currency: "INR" }, occurredAt: new Date().toISOString() }
  const verdict = await verify.verifyCapture(ctx.db, payments.paymentAdapterFor(process.env), event)
  assert.equal((await capture.applyCapture(ctx.db, verify.captureInputFor(verdict, event, "test-paid"))).outcome, "confirmed")
  return { orderId: placed.json.data.id, attemptId: opened.attemptId, total, payment, shopperJar: jar }
}

const refund = (o, { jar = owner.jar, amountPaise = o.total, reason = "buyer returned the item", key = `refund-${randomUUID()}`, body } = {}) =>
  call(forward, `/api/admin/payments/${o.attemptId}/refunds`, { method: "POST", jar, body: body ?? { amountPaise, reason }, headers: key ? { "idempotency-key": key } : {}, ip: newIp() })
const attemptOf = o => ctx.db.paymentAttempt.findUniqueOrThrow({ where: { id: o.attemptId }, select: { status: true, capturedAmountPaise: true } })
const refundsOf = o => ctx.db.refund.findMany({ where: { paymentAttemptId: o.attemptId }, orderBy: { createdAt: "asc" } })
const razorpayRefunds = o => [...razorpay.refunds.values()].filter(r => r.payment_id === o.payment.id)

async function webhook(refundRow, event) {
  const payment = razorpay.payments.get(refundRow.payment_id)
  const bytes = Buffer.from(JSON.stringify({ entity: "event", event, payload: { payment: { entity: payment }, refund: { entity: refundRow } }, created_at: 1793000000 }))
  const headers = new Headers({ "content-type": "application/json", "x-forwarded-for": "203.0.113.16", "x-razorpay-signature": createHmac("sha256", SANDBOX.RAZORPAY_WEBHOOK_SECRET).update(bytes).digest("hex"), "x-razorpay-event-id": `evt${randomBytes(8).toString("hex")}` })
  assert.equal((await forward(new Request(`${ORIGIN}/api/webhooks/razorpay`, { method: "POST", headers, body: bytes }), { params: Promise.resolve({}) })).status, 200)
}
const inboxPass = () => {
  const adapter = payments.paymentAdapterFor(process.env)
  return inbox.processWebhookInbox(ctx.db, handlers.paymentEventsHandler(ctx.db, adapter, failures.failureHandler(ctx.db, adapter), refunds.refundEventHandler(ctx.db, adapter)), { types: handlers.PAYMENT_EVENT_TYPES })
}

before(async () => {
  ctx = await setup("chaanavya_test_s14_refunds")
  forward = ctx.routes.me.GET
  owner = await staffWithMfa(ctx, "s14.refund.owner@example.com", "OWNER")
  admin = await staffWithMfa(ctx, "s14.refund.admin@example.com", "ADMIN")
  staffer = await staffWithMfa(ctx, "s14.refund.staff@example.com", "STAFF")
  plain = await createStaff(ctx, "s14.refund.no2fa@example.com", "OWNER")
  customer = await signInCustomer(ctx, "s14.refund.buyer@example.com")
  await ctx.db.taxProfile.create({ data: { sellerStateCode: "IN-KA", pricesIncludeTax: true, note: "synthetic test values", createdById: owner.user.id, rates: { create: [{ taxCategory: "apparel_cotton", hsnCode: "6204", rateBasisPoints: 500 }] } } })
  Object.assign(process.env, SANDBOX)
  globalThis.fetch = stubFetch
  ;[verify, capture, inbox, handlers, failures, refunds, payments] = await Promise.all(["payments/verify-capture", "orders/capture", "payments/inbox", "payments/capture-handler", "payments/failure-handler", "payments/refund", "integrations/payments"].map(apiModule))
})
after(() => {
  globalThis.fetch = realFetch
  for (const name of Object.keys(SANDBOX)) delete process.env[name]
  return ctx?.teardown()
})
beforeEach(() => {
  razorpay.mode = "processed"
  razorpay.lax = false
  razorpay.refuseConnection = false
})

describe("CHV-S14-M16 a refund needs permission", () => {
  test("a visitor, a customer, STAFF and staff without a two-factor session cannot refund; nothing reaches Razorpay", async () => {
    const o = await paidOrder()
    const before = razorpay.calls.length
    const noTwoFactor = new Jar()
    await call(forward, "/api/auth/sign-in/email", { method: "POST", jar: noTwoFactor, body: { email: "s14.refund.no2fa@example.com", password: plain.password }, ip: newIp() })
    for (const [who, jar, statuses] of [["visitor", new Jar(), [401]], ["customer", customer, [401, 403]], ["STAFF", staffer.jar, [403]], ["no two-factor", noTwoFactor, [401, 403]]]) {
      const res = await refund(o, { jar })
      assert.ok(statuses.includes(res.status), `${who}: ${res.status}`)
    }
    assert.equal(razorpay.calls.length, before)
    assert.deepEqual([(await refundsOf(o)).length, (await attemptOf(o)).status], [0, "captured"])
  })

  test("ADMIN refunds within the ₹5,000 limit (owner decision); above it only OWNER can", async () => {
    const big = await paidOrder(1299900n)
    const over = await refund(big, { jar: admin.jar })
    assert.deepEqual([over.status, over.json.error.fields?.amountPaise], [403, "over_limit"])
    assert.equal((await refundsOf(big)).length, 0)
    assert.equal((await refund(big, { jar: admin.jar, amountPaise: 500_000 })).status, 200, "exactly the limit")
    assert.equal((await refund(big, { jar: admin.jar, amountPaise: 500_001 })).json.error?.fields?.amountPaise, "over_limit", "one paisa above it")
    const rest = big.total - 500_000
    assert.equal((await refund(big, { jar: owner.jar, amountPaise: rest })).status, 200)
    assert.equal((await attemptOf(big)).status, "refunded")
  })

  test("the storefront has no way to start a refund: no shopper route, no web code calling the refund API", async () => {
    const o = await paidOrder()
    for (const path of [`/order/${o.orderId}/refund`, `/order/${o.orderId}/refunds`]) assert.ok([404, 405].includes((await cart("POST", path, { jar: o.shopperJar, body: { amountPaise: o.total } })).status), path)
    const sources = dir => readdirSync(join(ROOT, dir)).flatMap(name => (statSync(join(ROOT, dir, name)).isDirectory() ? sources(join(dir, name)) : /\.(tsx?|mjs)$/.test(name) ? [join(dir, name)] : []))
    const callers = ["app", "components", "lib"].filter(d => existsSync(join(ROOT, d))).flatMap(sources).filter(f => /admin\/payments|\/refunds/.test(readFileSync(join(ROOT, f), "utf8")))
    assert.deepEqual(callers.map(f => relative(".", f)), [], "no page or component calls a refund route")
  })
})

describe("CHV-S14-M16 a refund needs the correct paid amount", () => {
  test("a full refund succeeds with Razorpay's refund id and status; nothing more can be refunded after it", async () => {
    const o = await paidOrder()
    const res = await refund(o)
    assert.equal(res.status, 200, JSON.stringify(res.json))
    const [row] = await refundsOf(o)
    assert.deepEqual([res.json.data.status, res.json.data.amount, row.status, row.providerRefundId, Number(row.amountPaise)], ["succeeded", { amountPaise: o.total, currency: "INR" }, "succeeded", razorpayRefunds(o)[0].id, o.total])
    assert.equal((await attemptOf(o)).status, "refunded")
    const more = await refund(o, { amountPaise: 100 })
    assert.deepEqual([more.status, more.json.error.fields?.payment], [409, "refunded"], "a fully refunded payment cannot be refunded again")
    assert.equal(razorpayRefunds(o).length, 1)
    const audit = await ctx.db.auditEvent.findFirst({ where: { action: "refund.approved", entityId: row.id } })
    assert.deepEqual([audit.actorKind, audit.actorId, audit.after], ["staff", owner.user.id, { amountPaise: o.total }])
  })

  test("partial refunds add up to the paid amount and no further: partially refunded, then refunded, then refused", async () => {
    const o = await paidOrder()
    const half = Math.floor(o.total / 2)
    assert.equal((await refund(o, { amountPaise: half })).status, 200)
    assert.equal((await attemptOf(o)).status, "partially_refunded")
    const tooMuch = await refund(o, { amountPaise: o.total - half + 1 })
    assert.deepEqual([tooMuch.status, tooMuch.json.error.fields?.amountPaise, tooMuch.json.error.fields?.refundablePaise], [409, "over_refundable", String(o.total - half)])
    assert.equal((await refund(o, { amountPaise: o.total - half })).status, 200)
    assert.equal((await attemptOf(o)).status, "refunded")
    assert.equal(razorpayRefunds(o).reduce((a, r) => a + r.amount, 0), o.total)
  })

  test("a refund Razorpay already made outside our records (on its dashboard) counts against the balance", async () => {
    const o = await paidOrder()
    razorpay.payments.get(o.payment.id).amount_refunded = o.total - 500
    const res = await refund(o, { amountPaise: 1000 })
    assert.deepEqual([res.status, res.json.error.fields?.refundablePaise], [409, "500"])
    assert.equal((await refundsOf(o)).length, 0)
  })

  test("amounts that are not whole paise of at least ₹1, and anything but an amount and a reason, are refused", async () => {
    const o = await paidOrder()
    for (const body of [{ amountPaise: 0, reason: "x refund" }, { amountPaise: 99, reason: "x refund" }, { amountPaise: 1500.5, reason: "x refund" }, { amountPaise: "1500", reason: "x refund" }, { amountPaise: -100, reason: "x refund" }, { amountPaise: 1500 }, { amountPaise: 1500, reason: "x refund", currency: "USD" }, { amountPaise: 1500, reason: "x refund", providerPaymentId: "pay_Other" }]) {
      assert.equal((await refund(o, { body })).status, 400, JSON.stringify(body))
    }
    assert.equal((await refundsOf(o)).length, 0)
  })

  test("only a captured payment can be refunded; an unknown attempt is 404", async () => {
    const unpaid = await paidOrder(189900n, { pay: false })
    const res = await refund(unpaid)
    assert.deepEqual([res.status, res.json.error.fields?.payment], [409, "created"])
    const o = await paidOrder()
    assert.equal((await refund({ ...o, attemptId: randomUUID() })).status, 404)
    assert.equal((await refund({ ...o, attemptId: "not-a-uuid" })).status, 404)
  })
})

describe("CHV-S14-M16 a refund happens once, and its status is Razorpay's", () => {
  test("the same key again returns the same refund and asks Razorpay nothing new; the same key for another amount is refused", async () => {
    const o = await paidOrder()
    const first = await refund(o, { key: "refund-key-0001", amountPaise: 1000 })
    const again = await refund(o, { key: "refund-key-0001", amountPaise: 1000 })
    assert.deepEqual([again.status, again.json.data.id, again.json.created, first.json.created], [200, first.json.data.id, false, true])
    assert.equal((await refund(o, { key: "refund-key-0001", amountPaise: 2000 })).status, 409)
    assert.equal((await refund(o, { key: null })).status, 428)
    assert.equal(razorpayRefunds(o).length, 1)
  })

  test("five simultaneous full refunds with different keys: one refund, the others refused, never more than paid", async () => {
    const o = await paidOrder()
    razorpay.lax = true
    // Each refund's insert takes 0.3 s, so the five decisions truly overlap: only the attempt's lock keeps them apart.
    await ctx.db.$executeRawUnsafe(`CREATE FUNCTION test_slow_refund() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.3); RETURN NEW; END; $$`)
    await ctx.db.$executeRawUnsafe(`CREATE TRIGGER test_slow_refund BEFORE INSERT ON "refund" FOR EACH ROW EXECUTE FUNCTION test_slow_refund()`)
    let results
    try {
      results = await Promise.all(Array.from({ length: 5 }, () => refund(o)))
    } finally {
      await ctx.db.$executeRawUnsafe(`DROP TRIGGER test_slow_refund ON "refund"`)
      await ctx.db.$executeRawUnsafe(`DROP FUNCTION test_slow_refund()`)
    }
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409, 409, 409, 409])
    assert.equal(razorpayRefunds(o).length, 1)
    assert.equal((await refundsOf(o)).length, 1)
  })

  test("Razorpay made the refund but the answer was lost: the same request finds it by our key; never a second refund", async () => {
    const o = await paidOrder()
    razorpay.mode = "lose_answer"
    const res = await refund(o)
    assert.deepEqual([res.status, res.json.data.status, res.json.data.providerRefundId], [200, "succeeded", razorpayRefunds(o)[0].id])
    assert.equal(razorpayRefunds(o).length, 1)
  })

  test("the answer and the follow-up lookups lost: 502, and the retry with the same key adopts the refund, never a second", async () => {
    const o = await paidOrder()
    razorpay.mode = "lose_answer_and_lookups"
    razorpay.listsDown = 10
    const lostAnswer = await refund(o, { key: "refund-lost-0001" })
    assert.equal(lostAnswer.status, 502)
    razorpay.listsDown = 0
    assert.equal((await refundsOf(o))[0].status, "processing")
    razorpay.mode = "processed"
    const retried = await refund(o, { key: "refund-lost-0001" })
    assert.deepEqual([retried.status, retried.json.data.status, retried.json.data.providerRefundId], [200, "succeeded", razorpayRefunds(o)[0].id])
    assert.equal(razorpayRefunds(o).length, 1)
  })

  test("a pending refund waits for Razorpay's refund.processed webhook; refund.failed frees the amount again", async () => {
    const o = await paidOrder()
    razorpay.mode = "pending"
    const res = await refund(o, { amountPaise: 1000 })
    assert.deepEqual([res.json.data.status, (await attemptOf(o)).status], ["processing", "captured"])
    const [pending] = razorpayRefunds(o)
    pending.status = "processed"
    await webhook(pending, "refund.processed")
    await inboxPass()
    assert.deepEqual([(await refundsOf(o))[0].status, (await attemptOf(o)).status], ["succeeded", "partially_refunded"])

    const second = await refund(o, { amountPaise: 2000 })
    const failing = razorpayRefunds(o).find(r => r.id === second.json.data.providerRefundId)
    failing.status = "failed"
    razorpay.payments.get(o.payment.id).amount_refunded -= 2000
    await webhook(failing, "refund.failed")
    await inboxPass()
    assert.equal((await refundsOf(o)).find(r => r.providerRefundId === failing.id).status, "failed")
    assert.equal((await refund(o, { amountPaise: o.total - 1000 })).status, 200, "the failed refund's amount is refundable again")
  })

  test("a refund still under way (its request never reached Razorpay) counts: another key cannot refund the same money", async () => {
    const o = await paidOrder()
    razorpay.lax = true
    razorpay.refuseConnection = true
    const stuck = await refund(o, { key: "refund-stuck-0001" })
    assert.equal(stuck.status, 502)
    assert.deepEqual([(await refundsOf(o))[0].status, razorpayRefunds(o).length], ["processing", 0])
    razorpay.refuseConnection = false
    const other = await refund(o, { key: "refund-other-0001" })
    assert.deepEqual([other.status, other.json.error.fields?.refundablePaise], [409, "0"])
    assert.equal((await refund(o, { key: "refund-stuck-0001" })).json.data.status, "succeeded", "the stuck one is resumed with its own key")
    assert.equal(razorpayRefunds(o).length, 1)
  })

  test("a refund webhook that disagrees with Razorpay's own record of the refund is not believed", async () => {
    const o = await paidOrder()
    razorpay.mode = "pending"
    await refund(o, { amountPaise: 1000 })
    const [pending] = razorpayRefunds(o)
    // Razorpay's record says failed; an out-of-date event says processed.
    pending.status = "failed"
    await webhook({ ...pending, status: "processed" }, "refund.processed")
    await inboxPass()
    assert.deepEqual([(await refundsOf(o))[0].status, (await attemptOf(o)).status], ["failed", "captured"])
  })

  test("a refund Razorpay refuses is recorded as failed and refunds nothing", async () => {
    const o = await paidOrder()
    razorpay.mode = "reject"
    const res = await refund(o)
    assert.deepEqual([res.status, res.json.error.fields?.refund], [409, "provider_rejected"])
    assert.deepEqual([(await refundsOf(o))[0].status, (await attemptOf(o)).status], ["failed", "captured"])
  })

  test("in production the route does not exist; with payments off it is a 503", async () => {
    const o = await paidOrder()
    const previous = process.env.APP_ENV
    process.env.APP_ENV = "production"
    try {
      assert.equal((await refund(o)).status, 404)
    } finally {
      if (previous === undefined) delete process.env.APP_ENV
      else process.env.APP_ENV = previous
    }
    delete process.env.RAZORPAY_KEY_ID
    try {
      assert.equal((await refund(o)).status, 503)
    } finally {
      process.env.RAZORPAY_KEY_ID = SANDBOX.RAZORPAY_KEY_ID
    }
  })
})
