// CHV-S14-M05: a timeout does not produce a duplicate charge. The Razorpay adapter
// (apps/api/src/integrations/razorpay/adapter.ts) repeats only calls that are safe to repeat, within one time
// budget, and when it cannot know whether Razorpay opened the order (a timeout, a 5xx) it asks Razorpay for the
// attempt's order before anything new is created. Razorpay is a scripted stand-in on the network: each call
// can open the order and then lose the answer, time out, fail, or hang until it is aborted. All keys are fake.
// Orders are placed through the web host's forwarder. Tax values are synthetic test values.
import { after, before, beforeEach, describe, test } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { apiModule, call, createStaff, Jar, newIp, setup } from "../auth/helpers.mjs"

let ctx, forward, owner, adapterModule, configModule
let n = 0

const SANDBOX = { PAYMENT_MODE: "test", RAZORPAY_KEY_ID: "rzp_test_FAKE0000000015", RAZORPAY_KEY_SECRET: "fake-key-secret-14-05-0001", RAZORPAY_WEBHOOK_SECRET: "fake-webhook-secret-14-05-0001" }
const cart = (method, path, { jar, body, headers = {} } = {}) => call(forward, `/api/cart${path}`, { method, jar, body, headers, ip: newIp() })
const pay = (shopper, key = `pay-${randomUUID()}`) => cart("POST", `/order/${shopper.order.id}/payment`, { jar: shopper.jar, body: {}, headers: { "idempotency-key": key } })
const address = { name: "Synthetic Buyer", phone: "+91 60000 00000", line1: "1 Example Road", line2: null, landmark: null, city: "Bengaluru", district: "Bengaluru Urban", stateCode: "IN-KA", pinCode: "560034" }

// ---- the scripted Razorpay stand-in --------------------------------------------------------------
// Each call takes the next step from its method's script (then "ok"):
//   ok              answers normally
//   open_then_lose  opens the order, then the answer is lost to a timeout (Razorpay acted, we cannot know)
//   open_then_503   opens the order, then answers 503
//   timeout         times out before Razorpay acts
//   503 / 429       answers that status without acting
//   refused         the connection is refused: the request never left
//   hang            never answers; the caller's timeout must abort it
const provider = { calls: [], orders: [], script: { GET: [], POST: [] } }
const realFetch = globalThis.fetch
const timeoutError = () => new DOMException("The operation was aborted due to timeout", "TimeoutError")
async function stubFetch(url, init) {
  if (!String(url).startsWith("https://api.razorpay.com/")) return realFetch(url, init)
  const body = init?.body ? JSON.parse(init.body) : null
  const step = provider.script[init.method].shift() ?? "ok"
  provider.calls.push({ method: init.method, url: String(url), body, step })
  if (step === "hang") return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)))
  if (step === "refused") throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } })
  if (step === "timeout") throw timeoutError()
  if (step === "503" || step === "429") return { status: Number(step), json: async () => ({ error: { code: "SERVER_ERROR" } }) }
  if (init.method === "GET") {
    const items = provider.orders.filter(o => o.receipt === new URL(url).searchParams.get("receipt"))
    return { status: 200, json: async () => ({ entity: "collection", count: items.length, items }) }
  }
  const order = { id: `order_Fake${provider.orders.length + 1}x${randomUUID().slice(0, 8)}`, entity: "order", amount: body.amount, amount_paid: 0, currency: body.currency, receipt: body.receipt, notes: body.notes, status: "created" }
  provider.orders.push(order)
  if (step === "open_then_lose") throw timeoutError()
  if (step === "open_then_503") return { status: 503, json: async () => ({ error: { code: "SERVER_ERROR" } }) }
  return { status: 200, json: async () => order }
}
const creates = () => provider.calls.filter(c => c.method === "POST")
const lookups = () => provider.calls.filter(c => c.method === "GET")
/** Razorpay orders that exist for one of our attempts: more than one would let the buyer pay twice. */
const ordersFor = attemptId => provider.orders.filter(o => o.notes?.attempt_id === attemptId)

/** A shopper with a pending order for one item at ₹1,899. */
async function shopper() {
  n += 1
  const p = await ctx.db.product.create({
    data: { handle: `fixture-retry-${n}`, title: `Fixture retry ${n}`, status: "active", publishedAt: new Date(), shippingRestriction: "none", variants: { create: [{ sku: `fixture-retry-${n}-m`, title: "M", optionKey: "size:m", pricePaise: 189900n, taxCategory: "apparel_cotton", weightGrams: 300 }] } },
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
const attemptOf = async orderId => (await ctx.db.paymentAttempt.findMany({ where: { orderId } }))[0]

before(async () => {
  ctx = await setup("chaanavya_test_s14_gateway_retries")
  forward = ctx.routes.me.GET
  adapterModule = await apiModule("integrations/razorpay/adapter")
  configModule = await apiModule("integrations/razorpay/config")
  owner = (await createStaff(ctx, "s14.retry.owner@example.com", "OWNER")).user
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
  provider.script = { GET: [], POST: [] }
})

describe("CHV-S14-M05 a timeout never opens a second Razorpay order for one attempt", () => {
  test("Razorpay opens the order but the answer is lost: the same request asks for it and adopts it", async () => {
    const s = await shopper()
    provider.script.POST = ["open_then_lose"]
    const res = await pay(s)
    assert.equal(res.status, 200, JSON.stringify(res.json))
    const attempt = await attemptOf(s.order.id)
    assert.equal(creates().length, 1, "the create is not repeated after a timeout")
    assert.equal(ordersFor(attempt.id).length, 1)
    assert.deepEqual([res.json.data.providerOrderId, attempt.providerOrderId], [ordersFor(attempt.id)[0].id, ordersFor(attempt.id)[0].id])
    assert.equal(res.json.data.amount.amountPaise, s.total)
  })

  test("a 5xx after Razorpay acted is treated as unknown too: asked for, adopted, never created twice", async () => {
    const s = await shopper()
    provider.script.POST = ["open_then_503"]
    const res = await pay(s)
    assert.equal(res.status, 200, JSON.stringify(res.json))
    assert.equal(creates().length, 1)
    assert.equal(ordersFor((await attemptOf(s.order.id)).id).length, 1)
  })

  test("the answer and the lookups are lost: 502 with nothing recorded; the shopper's retry finds the order opened earlier", async () => {
    const s = await shopper()
    // The first lookup answers (nothing yet); the create opens the order and times out; every later lookup in
    // this request times out as well, so the request cannot know.
    provider.script.GET = ["ok", "timeout", "timeout", "timeout"]
    provider.script.POST = ["open_then_lose"]
    const first = await pay(s, "lost-answer-0001")
    assert.deepEqual([first.status, first.json.error.code], [502, "unavailable"])
    const attempt = await attemptOf(s.order.id)
    assert.deepEqual([attempt.providerOrderId, attempt.status], [null, "created"], "nothing guessed, nothing recorded")

    for (const key of ["lost-answer-0001", "lost-answer-0002"]) {
      const retry = await pay(s, key)
      assert.equal(retry.status, 200, key)
      assert.equal(retry.json.data.providerOrderId, ordersFor(attempt.id)[0].id, key)
    }
    assert.equal(creates().length, 1, "no second create: the retry asked Razorpay first")
    assert.equal(ordersFor(attempt.id).length, 1, "one Razorpay order for the attempt: one charge possible")
    assert.equal((await attemptOf(s.order.id)).providerOrderId, ordersFor(attempt.id)[0].id)
  })

  test("a timeout before Razorpay acted: 502 now, and the retry opens exactly one order", async () => {
    const s = await shopper()
    provider.script.POST = ["timeout"]
    const first = await pay(s)
    assert.equal(first.status, 502)
    assert.equal(creates().length, 1, "an unknown create is never repeated in the same request")
    const retry = await pay(s)
    assert.equal(retry.status, 200)
    assert.deepEqual([creates().length, ordersFor((await attemptOf(s.order.id)).id).length], [2, 1])
  })

  test("five simultaneous first requests while the create's answer is lost: one order, the same checkout for all", async () => {
    const s = await shopper()
    provider.script.POST = ["open_then_lose"]
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => pay(s, `lost-race-000${i}`)))
    assert.deepEqual(results.map(r => r.status), [200, 200, 200, 200, 200])
    assert.equal(new Set(results.map(r => r.json.data.providerOrderId)).size, 1)
    assert.deepEqual([creates().length, ordersFor((await attemptOf(s.order.id)).id).length], [1, 1])
  })
})

describe("CHV-S14-M05 retries are bounded and only where safe", () => {
  test("a create Razorpay certainly did not act on (refused connection, 429) is repeated, and still opens one order", async () => {
    for (const step of ["refused", "429"]) {
      provider.calls.length = 0
      const s = await shopper()
      provider.script.POST = [step]
      const res = await pay(s)
      assert.equal(res.status, 200, step)
      assert.deepEqual([creates().length, ordersFor((await attemptOf(s.order.id)).id).length], [2, 1], step)
    }
  })

  test("lookups change nothing, so they are repeated after a timeout, a refused connection or a 503", async () => {
    const s = await shopper()
    provider.script.GET = ["timeout", "503"]
    const res = await pay(s)
    assert.equal(res.status, 200)
    assert.deepEqual([lookups().length, creates().length], [3, 1])
  })

  test("a Razorpay that keeps failing is asked a bounded number of times, then the shopper gets a 502 and no order is created", async () => {
    const s = await shopper()
    provider.script.GET = ["503", "503", "503", "503", "503"]
    const res = await pay(s)
    assert.deepEqual([res.status, res.json.error.code], [502, "unavailable"])
    assert.deepEqual([lookups().length, creates().length], [adapterModule.RAZORPAY_RETRY.attempts, 0], "three lookups, then stop; never a blind create")
    assert.equal((await attemptOf(s.order.id)).providerOrderId, null)
  })

  test("the adapter's whole budget ends before the payment lock does", async () => {
    // start.ts holds the attempt's row lock for at most 20 seconds; the adapter must give up first.
    assert.ok(adapterModule.RAZORPAY_RETRY.budgetMs < 20_000)
    assert.ok(configModule.RAZORPAY_TIMEOUT_MS <= adapterModule.RAZORPAY_RETRY.budgetMs)
  })
})

describe("CHV-S14-M05 a hung Razorpay is cut off by the timeout", () => {
  const input = () => ({ attemptId: randomUUID(), reference: `CHV-T${randomUUID().slice(0, 6)}`, amount: { amountPaise: 189900, currency: "INR" }, returnUrl: "http://localhost:3000/checkout/payment", key: "k" })
  const adapter = budgetMs => adapterModule.razorpayAdapter(configModule.loadRazorpayConfig({ APP_ENV: "development", ...SANDBOX }).config, stubFetch, { retry: { budgetMs } })

  test("a create that never answers is aborted within the budget, is not repeated, and is reported as unknown", async () => {
    provider.script.POST = ["hang"]
    const started = Date.now()
    await assert.rejects(adapter(800).createCheckout(input()), e => e.kind === "timeout" && e.outcomeUnknown && e.retryable)
    const took = Date.now() - started
    assert.ok(took < 3_000, `gave up after ${took} ms`)
    assert.equal(creates().length, 1)
  })

  test("a lookup that never answers uses up the budget, and no create is attempted without knowing", async () => {
    provider.script.GET = ["hang", "hang", "hang"]
    await assert.rejects(adapter(800).createCheckout(input()), e => e.kind === "timeout" && e.outcomeUnknown)
    assert.equal(creates().length, 0)
  })

  test("an order Razorpay holds for the attempt but for another amount is never adopted or shown", async () => {
    const i = input()
    provider.orders.push({ id: "order_Mismatch0001", entity: "order", amount: 100, amount_paid: 0, currency: "INR", receipt: i.reference, notes: { attempt_id: i.attemptId }, status: "created" })
    const checkout = await adapter(5_000).createCheckout(i)
    assert.notEqual(checkout.providerOrderId, "order_Mismatch0001")
    assert.equal(checkout.next.publicParams.amount, "189900")
  })
})
