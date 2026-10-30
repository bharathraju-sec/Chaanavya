// CHV-S13-M02: the idempotent order intent (apps/api/src/orders/intent.ts, POST /api/cart/order). A
// checked quote becomes exactly one pending order: the same Idempotency-Key, the same quote under a
// new key, or many parallel submissions all return the original order. Keys belong to their shopper;
// the shown total is compared, never adopted; a stale, expired or changed quote places nothing. Calls
// go through the web host's forwarder, as the review page sends them. Tax values are synthetic test
// values; delivery is the sandbox courier.
import { after, before, describe, test } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { apiModule, call, createStaff, Jar, newIp, setup } from "../auth/helpers.mjs"

let ctx, forward, intent
let n = 0

const api = (method, path, { jar, body, headers = {} } = {}) => call(forward, `/api/cart${path}`, { method, jar, body, headers, ip: newIp() })
const address = { name: "Synthetic Buyer", phone: "+91 60000 00000", line1: "1 Example Road", line2: null, landmark: null, city: "Bengaluru", district: "Bengaluru Urban", stateCode: "IN-KA", pinCode: "560034" }
const submit = (jar, body, key = randomUUID()) => api("POST", "/order", { jar, body, headers: key === null ? {} : { "idempotency-key": key } })
const bodyFor = (quote, overrides = {}) => ({ quoteId: quote.id, expectedGrandTotal: quote.grandTotal, ...overrides })

async function variant() {
  n += 1
  const p = await ctx.db.product.create({
    data: { handle: `fixture-intent-${n}`, title: `Fixture intent ${n}`, status: "active", publishedAt: new Date(), shippingRestriction: "none", variants: { create: [{ sku: `fixture-intent-${n}-m`, title: "M", optionKey: "size:m", pricePaise: 189900n, taxCategory: "apparel_cotton", weightGrams: 400 }] } },
    include: { variants: true },
  })
  await ctx.db.inventoryBalance.create({ data: { variantId: p.variants[0].id, onHand: 20, lastCountedAt: new Date() } })
  return p.variants[0].id
}

/** A guest with a bag, a contact step and a checked quote. */
async function quoted() {
  const jar = new Jar()
  const variantId = await variant()
  assert.equal((await api("POST", "/lines", { jar, body: { variantId, quantity: 1 }, headers: { "idempotency-key": randomUUID() } })).status, 200)
  assert.equal((await api("PUT", "/contact", { jar, body: { email: "buyer@example.com", shippingAddress: address } })).status, 200)
  const quote = (await api("POST", "/quote", { jar, body: {} })).json.data
  assert.ok(quote?.id)
  return { jar, quote, variantId }
}
const ownerOf = async cartId => ({ kind: "guest", guestSessionId: (await ctx.db.cart.findUniqueOrThrow({ where: { id: cartId } })).guestSessionId })
const ordersFor = quoteId => ctx.db.order.count({ where: { quoteRef: quoteId } })

before(async () => {
  ctx = await setup("chaanavya_test_s13_order_intent")
  forward = ctx.routes.me.GET
  intent = await apiModule("orders/intent")
  const { user } = await createStaff(ctx, "s13.intent.owner@example.com", "OWNER")
  await ctx.db.taxProfile.create({ data: { sellerStateCode: "IN-KA", pricesIncludeTax: true, note: "synthetic test values", createdById: user.id, rates: { create: [{ taxCategory: "apparel_cotton", hsnCode: "6204", rateBasisPoints: 500 }] } } })
})
after(() => ctx?.teardown())

describe("CHV-S13-M02 a duplicate submission returns the original order", () => {
  test("the first submission places one pending order copied from the quote; the quote is used up", async () => {
    const { jar, quote } = await quoted()
    const res = await submit(jar, bodyFor(quote))
    assert.equal(res.status, 201, JSON.stringify(res.json))
    assert.equal(res.response.headers.get("cache-control"), "no-store")
    const order = res.json.data
    assert.equal(res.json.replayed, false)
    assert.match(order.number, /^CHV-[0-9]{6,}$/)
    assert.deepEqual([order.status, order.quoteId, order.grandTotal, order.test], ["pending_payment", quote.id, quote.grandTotal, true])
    assert.deepEqual(order.items.map(i => [i.sku, i.quantity, i.lineTotal.amountPaise]), quote.lines.map(l => [l.sku, l.quantity, l.lineTotal.amountPaise]))
    const row = await ctx.db.order.findUniqueOrThrow({ where: { id: order.id } })
    assert.match(row.quoteFingerprint, /^[0-9a-f]{64}$/, "the snapshot of 13.01 is stored")
    assert.equal(await ctx.db.checkoutQuote.count({ where: { id: quote.id } }), 0, "the quote cannot be used again")
    assert.equal(await ctx.db.inventoryReservation.count({ where: { orderId: order.id } }), 1, "the order holds its stock (13.04)")
    assert.equal(await ctx.db.paymentAttempt.count(), 0, "no payment is taken")
  })

  test("the same key again returns the same order, unchanged, as a replay", async () => {
    const { jar, quote } = await quoted()
    const key = randomUUID()
    const first = await submit(jar, bodyFor(quote), key)
    assert.equal(first.status, 201)
    for (let i = 0; i < 3; i++) {
      const again = await submit(jar, bodyFor(quote), key)
      assert.equal(again.status, 200)
      assert.equal(again.json.replayed, true)
      assert.deepEqual(again.json.data, first.json.data)
    }
    assert.equal(await ordersFor(quote.id), 1)
  })

  test("the same quote under a new key (a double click after a reload) returns the same order", async () => {
    const { jar, quote } = await quoted()
    const first = (await submit(jar, bodyFor(quote))).json.data
    const again = await submit(jar, bodyFor(quote))
    assert.deepEqual([again.status, again.json.replayed, again.json.data.id], [200, true, first.id])
    assert.equal(await ordersFor(quote.id), 1)
  })

  test("a replay is answered without checking again: it still returns the order after prices and stock change", async () => {
    const { jar, quote, variantId } = await quoted()
    const key = randomUUID()
    const first = (await submit(jar, bodyFor(quote), key)).json.data
    await ctx.db.productVariant.update({ where: { id: variantId }, data: { pricePaise: 99900n } })
    await ctx.db.inventoryBalance.update({ where: { variantId }, data: { reserved: 20 } })
    const again = await submit(jar, bodyFor(quote), key)
    assert.deepEqual([again.status, again.json.data], [200, first])
  })

  test("parallel submissions, with one key or many, make exactly one order and all get it", async () => {
    for (const keys of ["same", "different"]) {
      const { jar, quote } = await quoted()
      const key = randomUUID()
      const results = await Promise.all(Array.from({ length: 8 }, () => submit(jar, bodyFor(quote), keys === "same" ? key : randomUUID())))
      assert.ok(results.every(r => r.status === 200 || r.status === 201), results.map(r => `${r.status} ${JSON.stringify(r.json?.error ?? "")}`).join(" | "))
      assert.equal(results.filter(r => r.status === 201).length, 1, `${keys} keys: one creates`)
      assert.equal(new Set(results.map(r => r.json.data.id)).size, 1, `${keys} keys: all answer with the same order`)
      assert.equal(await ordersFor(quote.id), 1)
    }
  })
})

describe("CHV-S13-M02 keys, totals and quotes are checked", () => {
  test("a key reused for another quote is refused; keys belong to their shopper", async () => {
    const mine = await quoted()
    const key = randomUUID()
    assert.equal((await submit(mine.jar, bodyFor(mine.quote), key)).status, 201)
    const second = (await api("POST", "/quote", { jar: mine.jar, body: {} })).json.data
    const reused = await submit(mine.jar, bodyFor(second), key)
    assert.deepEqual([reused.status, reused.json.error.fields["Idempotency-Key"]], [409, "reused"])

    const theirs = await quoted()
    const sameKey = await submit(theirs.jar, bodyFor(theirs.quote), key)
    assert.equal(sameKey.status, 201, "another shopper's identical key places their own order, never returns mine")
    assert.notEqual(sameKey.json.data.id, (await ctx.db.order.findFirstOrThrow({ where: { quoteRef: mine.quote.id } })).id)
  })

  test("another shopper's quote, an unknown quote or no session places nothing", async () => {
    const mine = await quoted()
    const stranger = await quoted()
    assert.equal((await submit(stranger.jar, bodyFor(mine.quote))).status, 404)
    assert.equal((await submit(mine.jar, bodyFor(mine.quote, { quoteId: randomUUID() }))).status, 404)
    assert.equal((await submit(new Jar(), bodyFor(mine.quote))).status, 404)
    assert.equal(await ordersFor(mine.quote.id), 0)
    assert.equal((await submit(mine.jar, bodyFor(mine.quote))).status, 201, "the owner still can")
  })

  test("a total that differs from the quote places nothing and leaves the quote usable", async () => {
    const { jar, quote } = await quoted()
    for (const expectedGrandTotal of [{ amountPaise: quote.grandTotal.amountPaise - 1, currency: "INR" }, { amountPaise: 1, currency: "INR" }]) {
      const res = await submit(jar, bodyFor(quote, { expectedGrandTotal }))
      assert.deepEqual([res.status, res.json.error.fields.expectedGrandTotal], [409, "amount_mismatch"])
    }
    assert.equal(await ordersFor(quote.id), 0)
    const key = randomUUID()
    assert.equal((await submit(jar, bodyFor(quote), key)).status, 201)
    const replayWrongTotal = await submit(jar, bodyFor(quote, { expectedGrandTotal: { amountPaise: 1, currency: "INR" } }), key)
    assert.deepEqual([replayWrongTotal.status, replayWrongTotal.json.error.fields.expectedGrandTotal], [409, "amount_mismatch"], "a replay is checked against the order's total too")
  })

  test("prices, totals or items sent in the body are ignored: the order is the quote's", async () => {
    const { jar, quote } = await quoted()
    const res = await submit(jar, { ...bodyFor(quote), grandTotal: { amountPaise: 1, currency: "INR" }, unitPricePaise: 1, items: [{ sku: "x", quantity: 99, lineTotal: { amountPaise: 1 } }], status: "paid", shippingFee: 0 })
    assert.equal(res.status, 201)
    assert.deepEqual([res.json.data.status, res.json.data.grandTotal, res.json.data.items.length], ["pending_payment", quote.grandTotal, 1])
  })

  test("a bag changed after quoting, or an expired quote, places nothing", async () => {
    const changed = await quoted()
    assert.equal((await api("POST", "/lines", { jar: changed.jar, body: { variantId: await variant(), quantity: 1 }, headers: { "idempotency-key": randomUUID() } })).status, 200)
    const refused = await submit(changed.jar, bodyFor(changed.quote))
    assert.deepEqual([refused.status, refused.json.error.fields.quote], [409, "changed"])
    assert.equal(await ordersFor(changed.quote.id), 0)

    const old = await quoted()
    const owner = await ownerOf(old.quote.cartId)
    await assert.rejects(intent.placeOrderIntent(ctx.db, owner, randomUUID(), bodyFor(old.quote), { now: new Date(new Date(old.quote.expiresAt).getTime() + 1) }), e => e.status === 409 && e.fields.quote === "expired")
    assert.equal(await ordersFor(old.quote.id), 0)
  })

  test("the request must carry a key and a well-formed body", async () => {
    const { jar, quote } = await quoted()
    assert.equal((await submit(jar, bodyFor(quote), null)).status, 428)
    assert.equal((await submit(jar, bodyFor(quote), "short")).status, 400)
    assert.equal((await submit(jar, bodyFor(quote), "has spaces in it")).status, 400)
    assert.deepEqual((await submit(jar, { quoteId: "nope", expectedGrandTotal: quote.grandTotal })).json.error.fields, { quoteId: "invalid" })
    assert.deepEqual((await submit(jar, { quoteId: quote.id })).json.error.fields, { expectedGrandTotal: "invalid" })
    assert.deepEqual((await submit(jar, bodyFor(quote, { expectedGrandTotal: { amountPaise: 1.5, currency: "INR" } }))).json.error.fields, { expectedGrandTotal: "invalid" })
    assert.deepEqual((await submit(jar, bodyFor(quote, { expectedGrandTotal: { amountPaise: quote.grandTotal.amountPaise, currency: "USD" } }))).json.error.fields, { expectedGrandTotal: "invalid" })
    assert.equal(await ordersFor(quote.id), 0)
  })
})

describe("CHV-S13-M02 orders are placed only where checkout is open", () => {
  test("production answers 404 and places nothing, even for a valid quote", async () => {
    const { quote } = await quoted()
    const owner = await ownerOf(quote.cartId)
    await assert.rejects(intent.placeOrderIntent(ctx.db, owner, randomUUID(), bodyFor(quote), { env: { APP_ENV: "production" } }), e => e.status === 404)
    assert.equal(intent.orderIntentOpen({ APP_ENV: "production" }), false)
    assert.equal(intent.orderIntentOpen({ VERCEL_ENV: "production" }), false)
    assert.equal(intent.orderIntentOpen({ APP_ENV: "staging" }), true)
    assert.equal(await ordersFor(quote.id), 0)
  })

  test("stored keys are per-shopper digests, never the key itself", async () => {
    const { jar, quote } = await quoted()
    const key = `visible-key-${randomUUID()}`
    const order = (await submit(jar, bodyFor(quote), key)).json.data
    const row = await ctx.db.order.findUniqueOrThrow({ where: { id: order.id } })
    assert.match(row.submitKey, /^[0-9a-f]{64}$/)
    assert.ok(!row.submitKey.includes(key))
    assert.equal(row.submitKey, intent.submitKeyOf(await ownerOf(quote.cartId), key))
  })
})
