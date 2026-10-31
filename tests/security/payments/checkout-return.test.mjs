// CHV-S14-M07: the browser's success alone never marks an order paid. CHV-S14-M08 (at the end): a tampered
// payment id or signature is rejected; the signature is checked over the Razorpay order we stored. POST
// /api/cart/order/:orderId/payment/return (apps/api/src/payments/checkout-return.ts, the Razorpay adapter's
// verifyReturn) takes what Razorpay's checkout handed the browser as an untrusted signal: its shape is checked
// against the checkout we opened, nothing is recorded, and the answer is our own record of the order. Razorpay
// is a recording stand-in on the network for opening the checkout; keys and payment ids are fake. Orders are
// placed through the web host's forwarder. Tax values are synthetic test values.
import { after, before, beforeEach, describe, test } from "node:test"
import assert from "node:assert/strict"
import { createHmac, randomBytes, randomUUID } from "node:crypto"
import { apiModule, call, createStaff, Jar, newIp, setup, withOrigin } from "../auth/helpers.mjs"
import { returnFields } from "../../../lib/payment-handoff.ts"

let ctx, forward, owner
let n = 0

const SANDBOX = { PAYMENT_MODE: "test", RAZORPAY_KEY_ID: "rzp_test_FAKE0000000017", RAZORPAY_KEY_SECRET: "fake-key-secret-14-07-0001", RAZORPAY_WEBHOOK_SECRET: "fake-webhook-secret-14-07-0001" }
const cart = (method, path, { jar, body, headers = {}, raw } = {}) => call(forward, `/api/cart${path}`, { method, jar, body, headers, ip: newIp(), ...(raw && { raw }) })
const report = (shopper, body, { orderId = shopper.order.id, jar = shopper.jar } = {}) => cart("POST", `/order/${orderId}/payment/return`, { jar, body })
const address = { name: "Synthetic Buyer", phone: "+91 60000 00000", line1: "1 Example Road", line2: null, landmark: null, city: "Bengaluru", district: "Bengaluru Urban", stateCode: "IN-KA", pinCode: "560034" }

// ---- the Razorpay stand-in (orders API, for opening the checkout) --------------------------------
const provider = { calls: [], orders: [] }
const realFetch = globalThis.fetch
async function stubFetch(url, init) {
  if (!String(url).startsWith("https://api.razorpay.com/")) return realFetch(url, init)
  provider.calls.push({ method: init.method, url: String(url) })
  if (init.method === "GET") {
    const items = provider.orders.filter(o => o.receipt === new URL(url).searchParams.get("receipt"))
    return { status: 200, json: async () => ({ entity: "collection", count: items.length, items }) }
  }
  const body = JSON.parse(init.body)
  const order = { id: `order_Fake${provider.orders.length + 1}${randomUUID().slice(0, 6)}`, entity: "order", amount: body.amount, currency: body.currency, receipt: body.receipt, notes: body.notes, status: "created" }
  provider.orders.push(order)
  return { status: 200, json: async () => order }
}

/** Razorpay's checkout signature: HMAC-SHA256 of "<order id>|<payment id>" with the key secret. */
const sign = (providerOrderId, paymentId, secret = SANDBOX.RAZORPAY_KEY_SECRET) => createHmac("sha256", secret).update(`${providerOrderId}|${paymentId}`).digest("hex")
/** What Razorpay's checkout hands the browser on success, for one Razorpay order, signed as Razorpay signs it (fake key). */
const success = providerOrderId => {
  const paymentId = `pay_Fake${randomBytes(6).toString("hex")}`
  return { razorpay_payment_id: paymentId, razorpay_order_id: providerOrderId, razorpay_signature: sign(providerOrderId, paymentId) }
}

/** A shopper with a pending order for one item at ₹1,499 and, unless told not to, its checkout opened. */
async function shopper({ open = true } = {}) {
  n += 1
  const p = await ctx.db.product.create({
    data: { handle: `fixture-return-${n}`, title: `Fixture return ${n}`, status: "active", publishedAt: new Date(), shippingRestriction: "none", variants: { create: [{ sku: `fixture-return-${n}-m`, title: "M", optionKey: "size:m", pricePaise: 149900n, taxCategory: "apparel_cotton", weightGrams: 300 }] } },
    include: { variants: true },
  })
  await ctx.db.inventoryBalance.create({ data: { variantId: p.variants[0].id, onHand: 5, lastCountedAt: new Date() } })
  const jar = new Jar()
  assert.equal((await cart("POST", "/lines", { jar, body: { variantId: p.variants[0].id, quantity: 1 }, headers: { "idempotency-key": randomUUID() } })).status, 200)
  assert.equal((await cart("PUT", "/contact", { jar, body: { email: "buyer@example.com", shippingAddress: address } })).status, 200)
  const quote = (await cart("POST", "/quote", { jar, body: {} })).json.data
  const res = await cart("POST", "/order", { jar, body: { quoteId: quote.id, expectedGrandTotal: quote.grandTotal }, headers: { "idempotency-key": randomUUID() } })
  assert.equal(res.status, 201, JSON.stringify(res.json))
  const order = await ctx.db.order.findUniqueOrThrow({ where: { id: res.json.data.id } })
  let checkout = null
  if (open) {
    const opened = await cart("POST", `/order/${order.id}/payment`, { jar, body: {}, headers: { "idempotency-key": randomUUID() } })
    assert.equal(opened.status, 200, JSON.stringify(opened.json))
    checkout = opened.json.data
  }
  return { jar, order, checkout }
}

/** Everything a payment could move: the order, its attempts, stock hold, trail and provider events. */
async function stateOf(orderId) {
  const [order, attempts, reservation, events, providerEvents] = await Promise.all([
    ctx.db.order.findUniqueOrThrow({ where: { id: orderId } }),
    ctx.db.paymentAttempt.findMany({ where: { orderId }, orderBy: { createdAt: "asc" } }),
    ctx.db.inventoryReservation.findUnique({ where: { orderId } }),
    ctx.db.orderEvent.count({ where: { orderId } }),
    ctx.db.providerEvent.count(),
  ])
  return JSON.parse(JSON.stringify({ order, attempts, reservation, events, providerEvents }, (_, v) => (typeof v === "bigint" ? String(v) : v)))
}

before(async () => {
  ctx = await setup("chaanavya_test_s14_checkout_return")
  forward = ctx.routes.me.GET
  owner = (await createStaff(ctx, "s14.return.owner@example.com", "OWNER")).user
  await ctx.db.taxProfile.create({ data: { sellerStateCode: "IN-KA", pricesIncludeTax: true, note: "synthetic test values", createdById: owner.id, rates: { create: [{ taxCategory: "apparel_cotton", hsnCode: "6204", rateBasisPoints: 500 }] } } })
  Object.assign(process.env, SANDBOX)
  globalThis.fetch = stubFetch
})
after(() => {
  globalThis.fetch = realFetch
  for (const name of Object.keys(SANDBOX)) delete process.env[name]
  return ctx?.teardown()
})
beforeEach(() => {
  provider.calls.length = 0
})

describe("CHV-S14-M07 the browser saying 'paid' never marks the order paid", () => {
  test("a well-formed success report for the order's own checkout is read, and the order, payment and stock do not move", async () => {
    const s = await shopper()
    const before = await stateOf(s.order.id)
    provider.calls.length = 0
    const res = await report(s, success(s.checkout.providerOrderId))
    assert.equal(res.status, 200, JSON.stringify(res.json))
    assert.equal(res.response.headers.get("cache-control"), "no-store")
    assert.deepEqual(res.json.data, { orderId: s.order.id, orderStatus: "pending_payment", paymentStatus: "created", outcome: "confirming", verified: true })
    assert.deepEqual(await stateOf(s.order.id), before, "nothing about the order, its payment, its stock hold or its trail changed")
    const [attempt] = before.attempts
    assert.deepEqual([attempt.status, attempt.providerPaymentId, attempt.capturedAmountPaise], ["created", null, null])
    assert.equal(before.reservation.status, "active", "stock is still only held, not allocated")
    assert.equal(provider.calls.length, 0, "the report is not even taken to Razorpay as a lookup yet")
    // The order is still payable and still open to the shopper's own continue and cancel.
    assert.equal((await cart("GET", `/order/${s.order.id}`, { jar: s.jar })).json.data.status, "pending_payment")
  })

  test("replayed and simultaneous reports, with different payment ids, change nothing either", async () => {
    const s = await shopper()
    const before = await stateOf(s.order.id)
    const one = success(s.checkout.providerOrderId)
    const results = [await report(s, one), await report(s, one), ...(await Promise.all(Array.from({ length: 6 }, () => report(s, success(s.checkout.providerOrderId)))))]
    assert.deepEqual([...new Set(results.map(r => `${r.status}:${r.json.data?.outcome}`))], ["200:confirming"])
    assert.deepEqual(await stateOf(s.order.id), before)
  })

  test("reports that claim more (a status, an amount, paid: true) or do not have Razorpay's shape are refused, and change nothing", async () => {
    const s = await shopper()
    const good = success(s.checkout.providerOrderId)
    const before = await stateOf(s.order.id)
    const forged = [
      { ...good, status: "captured" },
      { ...good, paid: "true" },
      { ...good, amount: "100" },
      { razorpay_payment_id: good.razorpay_payment_id, razorpay_order_id: good.razorpay_order_id },
      { ...good, razorpay_payment_id: "not-a-payment" },
      { ...good, razorpay_signature: "abc" },
      { ...good, razorpay_signature: "G".repeat(64) },
      { ...good, razorpay_order_id: "order_SomeoneElse1" },
      { ...good, razorpay_payment_id: { id: "pay_x" } },
      { ...good, razorpay_payment_id: ["pay_x"] },
      { ...good, razorpay_payment_id: 12345 },
      { ...good, razorpay_payment_id: "" },
      { ...good, razorpay_payment_id: `pay_${"A".repeat(300)}` },
      {},
    ]
    for (const body of forged) {
      const res = await report(s, body)
      assert.deepEqual([res.status, res.json.error.code], [400, "invalid_request"], JSON.stringify(body))
    }
    assert.equal((await cart("POST", `/order/${s.order.id}/payment/return`, { jar: s.jar, body: { blob: "x".repeat(4096) } })).status, 413)
    assert.deepEqual(await stateOf(s.order.id), before)
  })

  test("another order's Razorpay checkout cannot be reported against this order", async () => {
    const [mine, theirs] = [await shopper(), await shopper()]
    const res = await report(mine, success(theirs.checkout.providerOrderId))
    assert.equal(res.status, 400)
    assert.equal((await report(theirs, success(mine.checkout.providerOrderId))).status, 400)
  })

  test("the answer is our record: a payment the provider failed is 'not_paid' whatever the browser says", async () => {
    const s = await shopper()
    await withOrigin(ctx.db, tx => tx.paymentAttempt.update({ where: { id: s.checkout.attemptId }, data: { status: "failed" } }))
    const res = await report(s, success(s.checkout.providerOrderId))
    assert.deepEqual([res.status, res.json.data.paymentStatus, res.json.data.outcome], [200, "failed", "not_paid"])
  })
})

describe("CHV-S14-M07 only the shopper's own opened checkout, only in the sandbox", () => {
  test("another shopper's order, a visitor, an unknown or malformed id are all 404; an order with no checkout is 409", async () => {
    const [mine, theirs] = [await shopper(), await shopper()]
    const body = success(theirs.checkout.providerOrderId)
    assert.equal((await report(mine, body, { orderId: theirs.order.id })).status, 404)
    assert.equal((await report(theirs, body, { jar: new Jar() })).status, 404)
    assert.equal((await report(mine, body, { orderId: randomUUID() })).status, 404)
    assert.equal((await report(mine, body, { orderId: "not-a-uuid" })).status, 404)
    const unopened = await shopper({ open: false })
    const res = await report(unopened, success("order_NeverOpened1"))
    assert.deepEqual([res.status, res.json.error.code], [409, "conflict"])
  })

  test("with payments off it is 503, and in production the route does not exist", async () => {
    const s = await shopper()
    delete process.env.RAZORPAY_KEY_ID
    try {
      assert.equal((await report(s, success(s.checkout.providerOrderId))).status, 503)
    } finally {
      process.env.RAZORPAY_KEY_ID = SANDBOX.RAZORPAY_KEY_ID
    }
    const previous = process.env.APP_ENV
    process.env.APP_ENV = "production"
    try {
      assert.equal((await report(s, success(s.checkout.providerOrderId))).status, 404)
    } finally {
      if (previous === undefined) delete process.env.APP_ENV
      else process.env.APP_ENV = previous
    }
  })

  test("the pay page passes on Razorpay's three fields only", () => {
    const fields = { razorpay_payment_id: "pay_A1", razorpay_order_id: "order_B2", razorpay_signature: "c".repeat(64) }
    assert.deepEqual(returnFields({ ...fields, status: "captured", amount: 1, paid: true }), fields)
    assert.equal(returnFields({ razorpay_payment_id: "pay_A1" }), null)
  })
})

describe("CHV-S14-M08 a tampered payment id or signature is rejected", () => {
  /** One hex digit changed. */
  const flip = hex => `${hex.slice(0, 10)}${hex[10] === "0" ? "1" : "0"}${hex.slice(11)}`

  test("a return Razorpay signed for this checkout verifies; the same return with any part changed does not, and nothing moves", async () => {
    const s = await shopper()
    const before = await stateOf(s.order.id)
    const good = success(s.checkout.providerOrderId)
    const ok = await report(s, good)
    assert.deepEqual([ok.status, ok.json.data.verified, ok.json.data.outcome], [200, true, "confirming"])

    const pay = good.razorpay_payment_id
    const tampered = [
      ["payment id changed, signature kept", { ...good, razorpay_payment_id: `${pay.slice(0, -1)}${pay.at(-1) === "a" ? "b" : "a"}` }],
      ["payment id swapped for another real-looking one", { ...good, razorpay_payment_id: "pay_Fake000000000001" }],
      ["one signature digit changed", { ...good, razorpay_signature: flip(good.razorpay_signature) }],
      ["the last signature digit changed", { ...good, razorpay_signature: `${good.razorpay_signature.slice(0, -1)}${good.razorpay_signature.at(-1) === "0" ? "1" : "0"}` }],
      ["signature made with another secret (the webhook secret)", { ...good, razorpay_signature: sign(s.checkout.providerOrderId, pay, SANDBOX.RAZORPAY_WEBHOOK_SECRET) }],
      ["signature made with a guessed secret", { ...good, razorpay_signature: sign(s.checkout.providerOrderId, pay, "guess") }],
      ["signature over the payment and order the wrong way round", { ...good, razorpay_signature: createHmac("sha256", SANDBOX.RAZORPAY_KEY_SECRET).update(`${pay}|${s.checkout.providerOrderId}`).digest("hex") }],
      ["signature over the order alone", { ...good, razorpay_signature: createHmac("sha256", SANDBOX.RAZORPAY_KEY_SECRET).update(s.checkout.providerOrderId).digest("hex") }],
      ["the signature in capitals", { ...good, razorpay_signature: good.razorpay_signature.toUpperCase() }],
      ["a signature of zeros", { ...good, razorpay_signature: "0".repeat(64) }],
    ]
    for (const [what, body] of tampered) {
      const res = await report(s, body)
      assert.deepEqual([res.status, res.json.error.code], [400, "invalid_request"], what)
    }
    assert.deepEqual(await stateOf(s.order.id), before, "nothing about the order or its payment changed")
  })

  test("a payment genuinely signed for another order cannot be moved onto this one", async () => {
    const [mine, theirs] = [await shopper(), await shopper()]
    const theirPayment = success(theirs.checkout.providerOrderId)
    // Their payment id and signature, but naming my Razorpay order (the order check passes, the signature cannot).
    const moved = { ...theirPayment, razorpay_order_id: mine.checkout.providerOrderId }
    const res = await report(mine, moved)
    assert.deepEqual([res.status, res.json.error.fields?.signature], [400, "mismatch"])
    // Unchanged, it is refused against my order because it names their checkout.
    assert.equal((await report(mine, theirPayment)).status, 400)
    // And it still verifies where it belongs.
    assert.equal((await report(theirs, theirPayment)).json.data.verified, true)
  })

  test("a valid signed return replayed, and sent many times at once, verifies each time and records nothing", async () => {
    const s = await shopper()
    const before = await stateOf(s.order.id)
    const good = success(s.checkout.providerOrderId)
    const results = [await report(s, good), ...(await Promise.all(Array.from({ length: 6 }, () => report(s, good))))]
    assert.deepEqual([...new Set(results.map(r => `${r.status}:${r.json.data?.verified}:${r.json.data?.outcome}`))], ["200:true:confirming"])
    assert.deepEqual(await stateOf(s.order.id), before)
  })

  test("the signature check itself: constant-time, needs the exact secret, and keeps the secret to itself", async () => {
    const { loadRazorpayConfig } = await apiModule("integrations/razorpay/config")
    const config = loadRazorpayConfig({ APP_ENV: "development", ...SANDBOX }).config
    const signature = sign("order_Abc", "pay_Xyz")
    assert.equal(config.checkoutSignatureMatches("order_Abc", "pay_Xyz", signature), true)
    assert.equal(config.checkoutSignatureMatches("order_Abd", "pay_Xyz", signature), false)
    assert.equal(config.checkoutSignatureMatches("order_Abc", "pay_Xyz", signature.slice(0, 62)), false, "a shorter signature never matches")
    assert.equal(config.checkoutSignatureMatches("order_Abc", "pay_Xyz", ""), false)
    const other = loadRazorpayConfig({ APP_ENV: "development", ...SANDBOX, RAZORPAY_KEY_SECRET: "another-fake-secret-0001" }).config
    assert.equal(other.checkoutSignatureMatches("order_Abc", "pay_Xyz", signature), false)
    assert.ok(!JSON.stringify(config).includes(SANDBOX.RAZORPAY_KEY_SECRET))
  })
})
