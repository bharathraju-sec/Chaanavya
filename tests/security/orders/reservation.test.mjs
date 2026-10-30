// CHV-S13-M04: a pending order holds its stock through the Stage 09 reservation interface
// (apps/api/src/inventory/reservations.ts: reserveWithin, the body of reserveStock), in the same
// transaction as the order (apps/api/src/orders/intent.ts). One reservation per order, one ledger
// movement per line, no stock arithmetic outside the ledger; when the hold fails the order is never
// created; replays and parallel submissions never hold twice. Calls go through the web host's
// forwarder. Tax values are synthetic test values; delivery is the sandbox courier.
import { after, before, describe, test } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { ROOT } from "../../integration/database/helpers.mjs"
import { apiModule, call, createStaff, Jar, newIp, setup } from "../auth/helpers.mjs"

let ctx, forward, intent, reservations
let n = 0

const api = (method, path, { jar, body, headers = {} } = {}) => call(forward, `/api/cart${path}`, { method, jar, body, headers, ip: newIp() })
const address = { name: "Synthetic Buyer", phone: "+91 60000 00000", line1: "1 Example Road", line2: null, landmark: null, city: "Bengaluru", district: "Bengaluru Urban", stateCode: "IN-KA", pinCode: "560034" }

async function variant(onHand = 20) {
  n += 1
  const p = await ctx.db.product.create({
    data: { handle: `fixture-hold-${n}`, title: `Fixture hold ${n}`, status: "active", publishedAt: new Date(), shippingRestriction: "none", variants: { create: [{ sku: `fixture-hold-${n}-m`, title: "M", optionKey: "size:m", pricePaise: 189900n, taxCategory: "apparel_cotton", weightGrams: 400 }] } },
    include: { variants: true },
  })
  await ctx.db.inventoryBalance.create({ data: { variantId: p.variants[0].id, onHand, lastCountedAt: new Date() } })
  return p.variants[0].id
}

/** A guest with a bag of these lines, a contact step and a checked quote. */
async function quoted(lines) {
  const jar = new Jar()
  for (const [variantId, quantity] of lines) assert.equal((await api("POST", "/lines", { jar, body: { variantId, quantity }, headers: { "idempotency-key": randomUUID() } })).status, 200)
  assert.equal((await api("PUT", "/contact", { jar, body: { email: "buyer@example.com", shippingAddress: address } })).status, 200)
  const quote = (await api("POST", "/quote", { jar, body: {} })).json.data
  assert.ok(quote?.id, "the API priced the bag")
  return { jar, quote }
}
const place = (jar, quote, key = randomUUID()) => api("POST", "/order", { jar, body: { quoteId: quote.id, expectedGrandTotal: quote.grandTotal }, headers: { "idempotency-key": key } })
const balance = variantId => ctx.db.inventoryBalance.findUniqueOrThrow({ where: { variantId } })
const movements = variantId => ctx.db.inventoryMovement.findMany({ where: { variantId }, orderBy: { occurredAt: "asc" } })

before(async () => {
  ctx = await setup("chaanavya_test_s13_order_reservation")
  forward = ctx.routes.me.GET
  intent = await apiModule("orders/intent")
  reservations = await apiModule("inventory/reservations")
  const { user } = await createStaff(ctx, "s13.hold.owner@example.com", "OWNER")
  await ctx.db.taxProfile.create({ data: { sellerStateCode: "IN-KA", pricesIncludeTax: true, note: "synthetic test values", createdById: user.id, rates: { create: [{ taxCategory: "apparel_cotton", hsnCode: "6204", rateBasisPoints: 500 }] } } })
})
after(() => ctx?.teardown())

describe("CHV-S13-M04 a pending order holds its stock through the Stage 09 reservation", () => {
  test("placing an order makes one reservation for every line, with one ledger movement each", async () => {
    const a = await variant(10)
    const b = await variant(10)
    const { jar, quote } = await quoted([[a, 2], [b, 1]])
    const before = { a: await balance(a), b: await balance(b) }
    const res = await place(jar, quote)
    assert.equal(res.status, 201, JSON.stringify(res.json))
    const order = await ctx.db.order.findUniqueOrThrow({ where: { id: res.json.data.id } })
    const hold = await ctx.db.inventoryReservation.findUniqueOrThrow({ where: { orderId: order.id }, include: { lines: true } })
    assert.equal(hold.status, "active")
    assert.equal(hold.idempotencyKey, `order:${order.id}`, "one hold per order, keyed by the order")
    assert.deepEqual(hold.lines.map(l => [l.variantId, l.quantity]).sort(), [[a, 2], [b, 1]].sort())
    assert.ok(Math.abs(hold.expiresAt.getTime() - order.payableUntil.getTime()) < 2000, "the hold lasts as long as the order is payable")
    for (const [id, qty] of [[a, 2], [b, 1]]) {
      const after = await balance(id)
      assert.deepEqual([after.onHand, after.reserved, after.allocated], [before[id === a ? "a" : "b"].onHand, before[id === a ? "a" : "b"].reserved + qty, 0])
      const moved = await movements(id)
      assert.deepEqual(moved.map(m => [m.type, m.quantity, m.referenceType, m.referenceId, m.idempotencyKey]), [["reservation", qty, "reservation", hold.id, `reserve:${hold.id}:${id}`]], "exactly the Stage 09 movement, nothing else")
    }
  })

  test("a replay or the same quote again never holds twice", async () => {
    const v = await variant(10)
    const { jar, quote } = await quoted([[v, 3]])
    const key = randomUUID()
    const first = await place(jar, quote, key)
    for (const again of [await place(jar, quote, key), await place(jar, quote)]) assert.deepEqual([again.status, again.json.data.id], [200, first.json.data.id])
    assert.equal(await ctx.db.inventoryReservation.count({ where: { orderId: first.json.data.id } }), 1)
    assert.equal((await balance(v)).reserved, 3)
    assert.equal((await movements(v)).length, 1)
  })

  test("parallel submissions of one quote hold the stock exactly once", async () => {
    const v = await variant(10)
    const { jar, quote } = await quoted([[v, 4]])
    const results = await Promise.all(Array.from({ length: 6 }, () => place(jar, quote)))
    assert.ok(results.every(r => r.status === 200 || r.status === 201), results.map(r => r.status).join())
    assert.equal(await ctx.db.inventoryReservation.count(), (await ctx.db.order.count({ where: { quoteRef: { not: null } } })), "one hold per order")
    assert.equal((await balance(v)).reserved, 4)
    assert.equal((await movements(v)).length, 1)
  })
})

describe("CHV-S13-M04 the order and its hold commit together or not at all", () => {
  test("two shoppers race for the last unit: one order holds it; the other is refused and nothing of theirs is written", async () => {
    const last = await variant(1)
    const one = await quoted([[last, 1]])
    const two = await quoted([[last, 1]])
    const results = await Promise.all([place(one.jar, one.quote), place(two.jar, two.quote)])
    const won = results.filter(r => r.status === 201)
    const lost = results.filter(r => r.status === 409)
    assert.equal(won.length, 1, results.map(r => `${r.status} ${JSON.stringify(r.json?.error?.fields ?? "")}`).join(" | "))
    assert.equal(lost.length, 1)
    const loserQuote = won[0].json.data.quoteId === one.quote.id ? two.quote : one.quote
    assert.ok(Object.values(lost[0].json.error.fields).some(v => /insufficient_stock|changed|out_of_stock/.test(v)), JSON.stringify(lost[0].json.error))
    assert.equal(await ctx.db.order.count({ where: { quoteRef: loserQuote.id } }), 0, "the losing order was rolled back with its failed hold")
    const b = await balance(last)
    assert.deepEqual([b.onHand, b.reserved], [1, 1], "never oversold")
    assert.equal((await movements(last)).length, 1)
  })

  test("when the hold fails after the order row is written, the order is rolled back too", async () => {
    const v = await variant(2)
    const { quote } = await quoted([[v, 2]])
    const cart = await ctx.db.cart.findUniqueOrThrow({ where: { id: quote.cartId } })
    const owner = { kind: "guest", guestSessionId: cart.guestSessionId }
    // Stock is taken by someone else only once the quote has been checked: the order row is written, then the hold fails.
    const before = await ctx.db.order.count()
    const realCheck = ctx.db.checkoutQuote.findUnique.bind(ctx.db.checkoutQuote)
    let taken = false
    ctx.db.checkoutQuote.findUnique = async args => {
      const row = await realCheck(args)
      if (!taken && args?.select?.fingerprint) {
        taken = true
        await ctx.db.inventoryBalance.update({ where: { variantId: v }, data: { reserved: 1 } })
      }
      return row
    }
    try {
      await assert.rejects(intent.placeOrderIntent(ctx.db, owner, randomUUID(), { quoteId: quote.id, expectedGrandTotal: quote.grandTotal }), e => e.status === 409 && Object.values(e.fields).includes("insufficient_stock"))
    } finally {
      ctx.db.checkoutQuote.findUnique = realCheck
    }
    assert.equal(taken, true)
    assert.equal(await ctx.db.order.count(), before, "no order without its hold")
    assert.equal(await ctx.db.inventoryReservation.count({ where: { lines: { some: { variantId: v } } } }), 0)
    assert.equal(await ctx.db.checkoutQuote.count({ where: { id: quote.id } }), 1, "the quote was not used up")
    assert.equal((await movements(v)).length, 0)
  })

  test("the hold lasts for the payment window, within the Stage 09 limits", async () => {
    const v = await variant(5)
    const { quote } = await quoted([[v, 1]])
    const cart = await ctx.db.cart.findUniqueOrThrow({ where: { id: quote.cartId } })
    const owner = { kind: "guest", guestSessionId: cart.guestSessionId }
    const nearlyOver = new Date(new Date(quote.expiresAt).getTime() - 10_000)
    const { order } = await intent.placeOrderIntent(ctx.db, owner, randomUUID(), { quoteId: quote.id, expectedGrandTotal: quote.grandTotal }, { now: nearlyOver })
    const hold = await ctx.db.inventoryReservation.findUniqueOrThrow({ where: { orderId: order.id } })
    const ttl = (hold.expiresAt.getTime() - hold.createdAt.getTime()) / 1000
    assert.ok(ttl >= reservations.RESERVATION_TTL.minSeconds - 1 && ttl <= reservations.RESERVATION_TTL.minSeconds + 2, `ten seconds left is held for the Stage 09 minimum, ${ttl}s`)
  })
})

describe("CHV-S13-M04 the Stage 09 interface is reused, not copied", () => {
  test("reserveStock keeps its behaviour: holds, replays with its key, refuses a reused key", async () => {
    const v = await variant(5)
    const { jar, quote } = await quoted([[v, 1]])
    const order = (await place(jar, quote)).json.data
    const direct = await ctx.db.order.create({ data: { email: "direct@example.com", subtotalPaise: 0n, grandTotalPaise: 0n, shippingAddress: {}, submitKey: randomUUID() } })
    const key = randomUUID()
    const first = await reservations.reserveStock(ctx.db, { orderId: direct.id, lines: [{ variantId: v, quantity: 1 }], idempotencyKey: key, correlationId: randomUUID() })
    assert.equal(first.ok, true)
    const again = await reservations.reserveStock(ctx.db, { orderId: direct.id, lines: [{ variantId: v, quantity: 1 }], idempotencyKey: key, correlationId: randomUUID() })
    assert.deepEqual([again.ok, again.replayed, again.reservationId], [true, true, first.reservationId])
    const reused = await reservations.reserveStock(ctx.db, { orderId: order.id, lines: [{ variantId: v, quantity: 1 }], idempotencyKey: key, correlationId: randomUUID() })
    assert.deepEqual([reused.ok, reused.reason], [false, "key_reused"])
    assert.equal((await balance(v)).reserved, 2)
  })

  test("the order code does no stock arithmetic: it calls the reservation code and nothing else touches balances or movements", () => {
    const source = readFileSync(join(ROOT, "apps/api/src/orders/intent.ts"), "utf8")
    assert.match(source, /reserveWithin\(tx, \{/)
    assert.doesNotMatch(source, /inventoryBalance|inventoryMovement|applyMovement|reserved:|onHand/, "no direct balance or ledger writes")
    const inventory = readFileSync(join(ROOT, "apps/api/src/inventory/reservations.ts"), "utf8")
    assert.match(inventory, /return await db\.\$transaction\(tx => reserveWithin\(tx, input\)/, "reserveStock is reserveWithin in its own transaction")
  })
})
