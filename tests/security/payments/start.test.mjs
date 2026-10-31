// CHV-S14-M04: the browser cannot override the amount the payment provider is asked for. POST
// /api/cart/order/:orderId/payment (apps/api/src/payments/start.ts, apps/api/src/integrations/razorpay/adapter.ts)
// opens a Razorpay sandbox order for the saved order's grand total in INR paise and nothing else; the request
// body is never read. Razorpay is replaced by a recording stand-in on the network (requests to its API host are
// answered here; everything else passes through). All keys are fake. Orders are placed through the web host's
// forwarder. Tax values are synthetic test values; delivery is the sandbox courier.
import { after, before, beforeEach, describe, test } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { apiModule, call, createStaff, Jar, newIp, setup, withOrigin } from "../auth/helpers.mjs"

let ctx, forward, owner, adapterModule
let n = 0

const SANDBOX = { PAYMENT_MODE: "test", RAZORPAY_KEY_ID: "rzp_test_FAKE0000000014", RAZORPAY_KEY_SECRET: "fake-key-secret-14-04-0001", RAZORPAY_WEBHOOK_SECRET: "fake-webhook-secret-14-04-0001" }
const cart = (method, path, { jar, body, headers = {} } = {}) => call(forward, `/api/cart${path}`, { method, jar, body, headers, ip: newIp() })
const pay = (shopper, { key = `pay-${randomUUID()}`, body = {}, query = "", headers = {}, orderId = shopper.order.id } = {}) =>
  cart("POST", `/order/${orderId}/payment${query}`, { jar: shopper.jar, body, headers: { ...(key && { "idempotency-key": key }), ...headers } })
const address = { name: "Synthetic Buyer", phone: "+91 60000 00000", line1: "1 Example Road", line2: null, landmark: null, city: "Bengaluru", district: "Bengaluru Urban", stateCode: "IN-KA", pinCode: "560034" }

// ---- the Razorpay stand-in -----------------------------------------------------------------------
const provider = { calls: [], orders: [], mode: "echo" }
const realFetch = globalThis.fetch
/** Answers like Razorpay's orders API: echoes the amount asked for, or misbehaves on purpose. It keeps the
 * orders it opened, so the adapter's lookup before creating (Stage 14.05) finds them as Razorpay would. */
async function stubFetch(url, init) {
  if (!String(url).startsWith("https://api.razorpay.com/")) return realFetch(url, init)
  const body = init?.body ? JSON.parse(init.body) : null
  provider.calls.push({ url: String(url), method: init.method, authorization: init.headers.authorization, body })
  if (provider.mode === "down") throw Object.assign(new Error("connect ECONNREFUSED"), { name: "TypeError" })
  if (provider.mode === "unauthorised") return { status: 401, json: async () => ({ error: { code: "BAD_REQUEST_ERROR" } }) }
  if (init.method === "GET") {
    const items = provider.orders.filter(o => o.receipt === new URL(url).searchParams.get("receipt"))
    return { status: 200, json: async () => ({ entity: "collection", count: items.length, items }) }
  }
  const amount = provider.mode === "wrong_amount" ? body.amount - 1 : body.amount
  const status = provider.mode === "already_paid" ? "paid" : "created"
  const order = { id: `order_Fake${provider.calls.length}x${randomUUID().slice(0, 8)}`, entity: "order", amount, amount_paid: 0, currency: body.currency, receipt: body.receipt, notes: body.notes, status }
  provider.orders.push(order)
  return { status: 200, json: async () => order }
}
/** The orders the provider was asked to create (lookups change nothing). */
const creates = () => provider.calls.filter(c => c.method === "POST")
const keyIdOf = authorization => Buffer.from(authorization.replace("Basic ", ""), "base64").toString().split(":")[0]

/** A shopper with a pending order for one item at ₹2,499. */
async function shopper() {
  n += 1
  const p = await ctx.db.product.create({
    data: { handle: `fixture-pay-${n}`, title: `Fixture pay ${n}`, status: "active", publishedAt: new Date(), shippingRestriction: "none", variants: { create: [{ sku: `fixture-pay-${n}-m`, title: "M", optionKey: "size:m", pricePaise: 249900n, taxCategory: "apparel_cotton", weightGrams: 300 }] } },
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
  return { jar, order, total: Number(order.grandTotalPaise) }
}
const attemptsOf = orderId => ctx.db.paymentAttempt.findMany({ where: { orderId } })

before(async () => {
  ctx = await setup("chaanavya_test_s14_start_payment")
  forward = ctx.routes.me.GET
  adapterModule = await apiModule("integrations/razorpay/adapter")
  owner = (await createStaff(ctx, "s14.pay.owner@example.com", "OWNER")).user
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
  provider.orders.length = 0
  provider.mode = "echo"
})

describe("CHV-S14-M04 the provider is asked for the saved order total, in INR paise", () => {
  test("opening the checkout creates one sandbox order for exactly the order's total, and the browser gets public values only", async () => {
    const s = await shopper()
    const res = await pay(s)
    assert.equal(res.status, 200, JSON.stringify(res.json))
    assert.equal(res.response.headers.get("cache-control"), "no-store")
    assert.equal(creates().length, 1)
    const [asked] = creates()
    assert.deepEqual([asked.method, new URL(asked.url).pathname, asked.body.amount, asked.body.currency, asked.body.receipt], ["POST", "/v1/orders", s.total, "INR", s.order.number])
    assert.equal(keyIdOf(asked.authorization), SANDBOX.RAZORPAY_KEY_ID, "the sandbox key, never a live one")

    const { data } = res.json
    assert.deepEqual([data.provider, data.amount, data.next.kind], ["razorpay", { amountPaise: s.total, currency: "INR" }, "embedded"])
    assert.deepEqual([data.next.publicParams.key, data.next.publicParams.order_id, data.next.publicParams.amount, data.next.publicParams.currency], [SANDBOX.RAZORPAY_KEY_ID, data.providerOrderId, String(s.total), "INR"])
    const text = JSON.stringify(res.json)
    for (const secret of [SANDBOX.RAZORPAY_KEY_SECRET, SANDBOX.RAZORPAY_WEBHOOK_SECRET]) assert.ok(!text.includes(secret))
    const [attempt] = await attemptsOf(s.order.id)
    assert.deepEqual([attempt.id, attempt.providerOrderId, attempt.amountPaise, attempt.status], [data.attemptId, data.providerOrderId, s.order.grandTotalPaise, "created"])
  })

  test("whatever the browser sends (body, query, headers), the provider is asked for the saved total", async () => {
    const forged = [
      { body: { amount: 100, currency: "INR" } },
      { body: { amountPaise: 1, grandTotal: { amountPaise: 1, currency: "INR" }, expectedGrandTotal: { amountPaise: 1, currency: "INR" } } },
      { body: { amount: 999999999, currency: "USD", providerOrderId: "order_Forged", attemptId: randomUUID() } },
      { query: "?amount=100&currency=USD" },
      { headers: { "x-amount": "100", "x-currency": "USD" } },
    ]
    for (const options of forged) {
      const s = await shopper()
      provider.calls.length = 0
      const res = await pay(s, options)
      assert.equal(res.status, 200, JSON.stringify(options))
      assert.deepEqual([creates().length, creates()[0].body.amount, creates()[0].body.currency], [1, s.total, "INR"], JSON.stringify(options))
      assert.deepEqual(res.json.data.amount, { amountPaise: s.total, currency: "INR" })
      assert.notEqual(res.json.data.providerOrderId, "order_Forged")
    }
  })
})

describe("CHV-S14-M04 one provider order per attempt, however often it is asked", () => {
  test("a retry, another tab, and five simultaneous requests all get the same checkout from one provider call", async () => {
    const s = await shopper()
    const first = await pay(s, { key: "checkout-key-0001" })
    const retry = await pay(s, { key: "checkout-key-0001" })
    const otherTab = await pay(s, { key: "checkout-key-0002" })
    const burst = await Promise.all(Array.from({ length: 5 }, (_, i) => pay(s, { key: `burst-key-000${i}` })))
    for (const res of [retry, otherTab, ...burst]) {
      assert.equal(res.status, 200)
      assert.deepEqual([res.json.data.attemptId, res.json.data.providerOrderId, res.json.reused], [first.json.data.attemptId, first.json.data.providerOrderId, true])
    }
    assert.equal(first.json.reused, false)
    assert.equal(creates().length, 1, "the provider was asked once")
    assert.equal((await attemptsOf(s.order.id)).length, 1)
  })

  test("five simultaneous first requests for a fresh order ask the provider once", async () => {
    const s = await shopper()
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => pay(s, { key: `first-race-000${i}` })))
    assert.deepEqual(results.map(r => r.status), [200, 200, 200, 200, 200])
    assert.equal(new Set(results.map(r => r.json.data.providerOrderId)).size, 1)
    assert.equal(creates().length, 1, "one provider order for one attempt")
  })

  test("a provider order for a different amount, or not new, is not believed: nothing recorded, and a retry asks again", async () => {
    for (const mode of ["wrong_amount", "already_paid"]) {
      const s = await shopper()
      provider.mode = mode
      const res = await pay(s, { key: "checkout-key-0003" })
      assert.deepEqual([res.status, res.json.error.code], [502, "unavailable"], mode)
      assert.equal((await attemptsOf(s.order.id))[0].providerOrderId, null, "no provider reference recorded")
      provider.mode = "echo"
      const retry = await pay(s, { key: "checkout-key-0003" })
      assert.equal(retry.status, 200)
      assert.equal(retry.json.data.amount.amountPaise, s.total)
    }
  })

  test("a provider that cannot be reached is a 502, a refused key a 503; nothing is recorded either way", async () => {
    for (const [mode, status] of [["down", 502], ["unauthorised", 503]]) {
      const s = await shopper()
      provider.mode = mode
      const res = await pay(s)
      assert.equal(res.status, status, mode)
      const [attempt] = await attemptsOf(s.order.id)
      assert.deepEqual([attempt.providerOrderId, attempt.status], [null, "created"], mode)
    }
  })
})

describe("CHV-S14-M04 only the shopper's own pending order, only in the sandbox", () => {
  test("another shopper's order is 404; a visitor, a missing or bad key are refused; the provider is never asked", async () => {
    const [mine, theirs] = [await shopper(), await shopper()]
    assert.equal((await pay(mine, { orderId: theirs.order.id })).status, 404)
    assert.equal((await pay({ jar: new Jar(), order: mine.order })).status, 404)
    assert.equal((await pay(mine, { orderId: randomUUID() })).status, 404)
    assert.equal((await pay(mine, { orderId: "not-a-uuid" })).status, 404)
    assert.equal((await pay(mine, { key: null })).status, 428)
    assert.equal((await pay(mine, { key: "bad key" })).status, 400)
    assert.equal(provider.calls.length, 0)
    assert.equal((await attemptsOf(theirs.order.id)).length, 0)
  })

  test("a cancelled order, or a payment already under way, is a 409 without a new provider order", async () => {
    const cancelled = await shopper()
    await withOrigin(ctx.db, tx => tx.order.update({ where: { id: cancelled.order.id }, data: { status: "cancelled" } }))
    assert.equal((await pay(cancelled)).status, 409)

    // An ended payment window is refused by openAttempt (tests/security/payments/attempts.test.mjs); an order's
    // deadline is part of its purchase snapshot and cannot be moved here to fake one.

    const busy = await shopper()
    const opened = await pay(busy)
    await withOrigin(ctx.db, tx => tx.paymentAttempt.update({ where: { id: opened.json.data.attemptId }, data: { status: "authorized" } }))
    const again = await pay(busy)
    assert.deepEqual([again.status, again.json.error.fields?.payment], [409, "authorized"])
    assert.equal(creates().length, 1, "only the first checkout asked the provider")
  })

  test("with payments off there is no checkout (503) and no attempt; in production the route does not exist", async () => {
    const s = await shopper()
    delete process.env.RAZORPAY_KEY_ID
    try {
      const res = await pay(s)
      assert.deepEqual([res.status, res.json.error.code], [503, "unavailable"])
    } finally {
      process.env.RAZORPAY_KEY_ID = SANDBOX.RAZORPAY_KEY_ID
    }
    const previous = process.env.APP_ENV
    process.env.APP_ENV = "production"
    try {
      assert.equal((await pay(s)).status, 404)
    } finally {
      if (previous === undefined) delete process.env.APP_ENV
      else process.env.APP_ENV = previous
    }
    assert.deepEqual([provider.calls.length, (await attemptsOf(s.order.id)).length], [0, 0])
  })

  test("the adapter itself refuses amounts below ₹1 and anything but INR, without asking the provider", async () => {
    const { loadRazorpayConfig } = await apiModule("integrations/razorpay/config")
    const adapter = adapterModule.razorpayAdapter(loadRazorpayConfig({ APP_ENV: "development", ...SANDBOX }).config)
    const input = amount => ({ attemptId: randomUUID(), reference: "CHV-1", amount, returnUrl: "http://localhost:3000/checkout/payment", key: "k" })
    for (const amount of [{ amountPaise: 99, currency: "INR" }, { amountPaise: 2.5, currency: "INR" }, { amountPaise: 249900, currency: "USD" }]) {
      await assert.rejects(adapter.createCheckout(input(amount)), e => e.kind === "rejected", JSON.stringify(amount))
    }
    assert.equal(provider.calls.length, 0)
  })
})
