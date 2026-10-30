// CHV-S13-M03: a pending order bound to its checkout (apps/api/src/orders/checkout-session.ts,
// GET /api/cart/order/:orderId, migration 20261028020000_order_checkout_binding). Only the shopper who
// placed an order can continue it: another guest, a customer, a signed-out visitor, an unknown id and a
// malformed id all get the same 404, so nobody can reuse someone else's order id. The order names the
// bag it came from and is payable only until its quote's expiry; an ended bag, an expired window or a
// status other than pending ends the checkout. Calls go through the web host's forwarder. Tax values
// are synthetic test values; delivery is the sandbox courier.
import { after, before, describe, test } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { apiModule, call, createStaff, Jar, newIp, setup, signInCustomer, withOrigin } from "../auth/helpers.mjs"

let ctx, forward, session
let n = 0

const api = (method, path, { jar, body, headers = {} } = {}) => call(forward, `/api/cart${path}`, { method, jar, body, headers, ip: newIp() })
const address = { name: "Synthetic Buyer", phone: "+91 60000 00000", line1: "1 Example Road", line2: null, landmark: null, city: "Bengaluru", district: "Bengaluru Urban", stateCode: "IN-KA", pinCode: "560034" }
const pending = (jar, id) => api("GET", `/order/${id}`, { jar })

/** A shopper (guest, or the given signed-in jar) who has placed one pending order. */
async function placedOrder(jar = new Jar()) {
  n += 1
  const p = await ctx.db.product.create({
    data: { handle: `fixture-session-${n}`, title: `Fixture session ${n}`, status: "active", publishedAt: new Date(), shippingRestriction: "none", variants: { create: [{ sku: `fixture-session-${n}-m`, title: "M", optionKey: "size:m", pricePaise: 189900n, taxCategory: "apparel_cotton", weightGrams: 400 }] } },
    include: { variants: true },
  })
  await ctx.db.inventoryBalance.create({ data: { variantId: p.variants[0].id, onHand: 20, lastCountedAt: new Date() } })
  assert.equal((await api("POST", "/lines", { jar, body: { variantId: p.variants[0].id, quantity: 1 }, headers: { "idempotency-key": randomUUID() } })).status, 200)
  assert.equal((await api("PUT", "/contact", { jar, body: { shippingAddress: address, ...(jar.has("chaanavya_guest") ? { email: "buyer@example.com" } : {}) } })).status, 200)
  const quote = (await api("POST", "/quote", { jar, body: {} })).json.data
  const placed = await api("POST", "/order", { jar, body: { quoteId: quote.id, expectedGrandTotal: quote.grandTotal }, headers: { "idempotency-key": randomUUID() } })
  assert.equal(placed.status, 201, JSON.stringify(placed.json))
  return { jar, quote, order: placed.json.data }
}

before(async () => {
  ctx = await setup("chaanavya_test_s13_checkout_session")
  forward = ctx.routes.me.GET
  session = await apiModule("orders/checkout-session")
  const { user } = await createStaff(ctx, "s13.session.owner@example.com", "OWNER")
  await ctx.db.taxProfile.create({ data: { sellerStateCode: "IN-KA", pricesIncludeTax: true, note: "synthetic test values", createdById: user.id, rates: { create: [{ taxCategory: "apparel_cotton", hsnCode: "6204", rateBasisPoints: 500 }] } } })
})
after(() => ctx?.teardown())

describe("CHV-S13-M03 an order is bound to the checkout it came from", () => {
  test("a placed order names its bag, and is payable until its quote's expiry", async () => {
    const { quote, order } = await placedOrder()
    const row = await ctx.db.order.findUniqueOrThrow({ where: { id: order.id } })
    assert.equal(row.cartId, quote.cartId)
    assert.equal(row.payableUntil.toISOString(), new Date(quote.expiresAt).toISOString())
    assert.equal(order.payableUntil, new Date(quote.expiresAt).toISOString())
  })

  test("the shopper who placed it can continue it", async () => {
    const { jar, order } = await placedOrder()
    const res = await pending(jar, order.id)
    assert.equal(res.status, 200, JSON.stringify(res.json))
    assert.equal(res.response.headers.get("cache-control"), "no-store")
    assert.deepEqual(res.json.data, order)
  })
})

describe("CHV-S13-M03 a customer cannot reuse someone else's order id", () => {
  test("another guest, a signed-in customer and a signed-out visitor all get the same 404 as an unknown id", async () => {
    const { order } = await placedOrder()
    const unknown = await pending(new Jar(), randomUUID())
    const answers = []
    const otherGuest = (await placedOrder()).jar
    answers.push(await pending(otherGuest, order.id))
    const customer = await signInCustomer(ctx, `s13.session.${randomUUID().slice(0, 8)}@example.com`)
    answers.push(await pending(customer, order.id))
    answers.push(await pending(new Jar(), order.id))
    for (const res of answers) {
      assert.equal(res.status, 404)
      assert.deepEqual(res.json, unknown.json, "a foreign order answers exactly like a missing one")
    }
    for (const id of ["not-a-uuid", `${order.id}' OR '1'='1`, order.number]) assert.equal((await pending(otherGuest, id)).status, 404)
  })

  test("a foreign order cannot be placed again, replayed or continued with its own key or quote", async () => {
    const mine = await placedOrder()
    const stranger = await placedOrder()
    const reuse = await api("POST", "/order", { jar: stranger.jar, body: { quoteId: mine.quote.id, expectedGrandTotal: mine.quote.grandTotal }, headers: { "idempotency-key": randomUUID() } })
    assert.equal(reuse.status, 404, "someone else's quote is not found")
    assert.equal(await ctx.db.order.count({ where: { quoteRef: mine.quote.id } }), 1)
    assert.equal(await ctx.db.order.count({ where: { guestSessionId: (await ctx.db.order.findUniqueOrThrow({ where: { id: mine.order.id } })).guestSessionId } }), 1, "no order moved to the stranger")
  })

  test("a guest's order stays with the guest session: after signing in it is not the customer's to continue", async () => {
    const guest = await placedOrder()
    await signInCustomer(ctx, `s13.session.merge.${randomUUID().slice(0, 8)}@example.com`, { jar: guest.jar })
    await api("GET", "", { jar: guest.jar })
    assert.equal((await pending(guest.jar, guest.order.id)).status, 404)
  })

  test("a customer's order is theirs alone: another customer and the customer's earlier guest session are refused", async () => {
    const email = `s13.session.customer.${randomUUID().slice(0, 8)}@example.com`
    const jar = await signInCustomer(ctx, email)
    const { order } = await placedOrder(jar)
    assert.equal((await pending(jar, order.id)).status, 200)
    const other = await signInCustomer(ctx, `s13.session.other.${randomUUID().slice(0, 8)}@example.com`)
    assert.equal((await pending(other, order.id)).status, 404)
    assert.equal((await pending(new Jar(), order.id)).status, 404)
  })
})

describe("CHV-S13-M03 the checkout must still be live", () => {
  test("at or after the payment window the order cannot be continued", async () => {
    const { order, quote } = await placedOrder()
    const row = await ctx.db.order.findUniqueOrThrow({ where: { id: order.id } })
    const owner = { kind: "guest", guestSessionId: row.guestSessionId }
    const expires = new Date(quote.expiresAt).getTime()
    assert.equal((await session.pendingOrderFor(ctx.db, owner, order.id, new Date(expires - 1))).id, order.id)
    await assert.rejects(session.pendingOrderFor(ctx.db, owner, order.id, new Date(expires)), e => e.status === 409 && e.fields.order === "expired")
  })

  test("an order that is no longer pending cannot be continued", async () => {
    const { jar, order } = await placedOrder()
    await withOrigin(ctx.db, tx => tx.order.update({ where: { id: order.id }, data: { status: "cancelled" } }))
    const res = await pending(jar, order.id)
    assert.deepEqual([res.status, res.json.error.fields.order], [409, "not_pending"])
  })

  test("when the bag it came from is gone, the checkout has ended", async () => {
    const { jar, order, quote } = await placedOrder()
    await ctx.db.cart.delete({ where: { id: quote.cartId } })
    const row = await ctx.db.order.findUniqueOrThrow({ where: { id: order.id } })
    assert.equal(row.cartId, null, "deleting the bag clears the link, nothing else")
    const res = await pending(jar, order.id)
    assert.deepEqual([res.status, res.json.error.fields.order], [409, "checkout_ended"])
  })

  test("the bag link and payment window are frozen: they cannot be moved or extended", async () => {
    const { order } = await placedOrder()
    const { quote: other } = await placedOrder()
    const edit = data => ctx.db.order.update({ where: { id: order.id }, data })
    await assert.rejects(edit({ cartId: other.cartId }), /purchase snapshot/, "moving the order to another bag")
    await assert.rejects(edit({ payableUntil: new Date(Date.now() + 86_400_000) }), /purchase snapshot/, "extending the window")
    const row = await ctx.db.order.findUniqueOrThrow({ where: { id: order.id } })
    await assert.rejects(ctx.db.order.create({ data: { email: "x@example.com", subtotalPaise: 0n, grandTotalPaise: 0n, shippingAddress: {}, submitKey: randomUUID(), quoteRef: randomUUID(), quoteFingerprint: row.quoteFingerprint, customerSnapshot: row.customerSnapshot, taxSnapshot: row.taxSnapshot, shippingSnapshot: { ...row.shippingSnapshot, fee: { amountPaise: 0, currency: "INR" } } } }), /violates check constraint/, "a quote order without a payment window")
  })

  test("the route is closed in production", async () => {
    const { jar, order } = await placedOrder()
    const before = process.env.APP_ENV
    process.env.APP_ENV = "production"
    try {
      assert.equal((await pending(jar, order.id)).status, 404)
    } finally {
      process.env.APP_ENV = before
    }
  })
})
