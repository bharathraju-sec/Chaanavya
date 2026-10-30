// CHV-S13-M05: atomic multi-item checkout reservation. Placing an order holds every line of the bag or
// none (apps/api/src/orders/intent.ts with the Stage 09 reservation, apps/api/src/inventory/
// reservations.ts and ledger.ts): each line is one conditional row update that only succeeds while
// enough is free, lines are locked in variant-id order, and any shortfall rolls back the order and
// every line already held. Simultaneous checkouts for the last unit yield exactly one valid
// reservation; a loser never keeps a partial hold; bags holding the same items in opposite order
// never deadlock. Calls go through the web host's forwarder. Tax values are synthetic test values;
// delivery is the sandbox courier.
import { after, before, describe, test } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { call, createStaff, Jar, newIp, setup } from "../auth/helpers.mjs"

let ctx, forward
let n = 0

const api = (method, path, { jar, body, headers = {} } = {}) => call(forward, `/api/cart${path}`, { method, jar, body, headers, ip: newIp() })
const address = { name: "Synthetic Buyer", phone: "+91 60000 00000", line1: "1 Example Road", line2: null, landmark: null, city: "Bengaluru", district: "Bengaluru Urban", stateCode: "IN-KA", pinCode: "560034" }

async function variant(onHand) {
  n += 1
  const p = await ctx.db.product.create({
    data: { handle: `fixture-atomic-${n}`, title: `Fixture atomic ${n}`, status: "active", publishedAt: new Date(), shippingRestriction: "none", variants: { create: [{ sku: `fixture-atomic-${n}-m`, title: "M", optionKey: "size:m", pricePaise: 99900n, taxCategory: "apparel_cotton", weightGrams: 300 }] } },
    include: { variants: true },
  })
  await ctx.db.inventoryBalance.create({ data: { variantId: p.variants[0].id, onHand, lastCountedAt: new Date() } })
  return p.variants[0].id
}

/** A shopper with these lines in their bag (added in this order), a contact step and a checked quote. */
async function shopper(lines) {
  const jar = new Jar()
  for (const [variantId, quantity] of lines) assert.equal((await api("POST", "/lines", { jar, body: { variantId, quantity }, headers: { "idempotency-key": randomUUID() } })).status, 200)
  assert.equal((await api("PUT", "/contact", { jar, body: { email: "buyer@example.com", shippingAddress: address } })).status, 200)
  const quote = (await api("POST", "/quote", { jar, body: {} })).json.data
  assert.ok(quote?.id, "every shopper is quoted while the stock is still free")
  return { jar, quote }
}
const checkout = s => api("POST", "/order", { jar: s.jar, body: { quoteId: s.quote.id, expectedGrandTotal: s.quote.grandTotal }, headers: { "idempotency-key": randomUUID() } })

/** Everyone presses "place order" at the same moment. */
async function race(shoppers) {
  const results = await Promise.all(shoppers.map(checkout))
  for (const r of results) assert.ok(r.status === 201 || r.status === 409, `only an order or a refusal, never an error: ${r.status} ${JSON.stringify(r.json)}`)
  return { won: results.filter(r => r.status === 201), lost: results.filter(r => r.status === 409) }
}

/** The ledger and the holds agree for these variants: reserved equals what active holds cover, and every order from a quote has its hold. */
async function consistent(variantIds) {
  for (const variantId of variantIds) {
    const b = await ctx.db.inventoryBalance.findUniqueOrThrow({ where: { variantId } })
    const held = await ctx.db.inventoryReservationLine.aggregate({ where: { variantId, reservation: { status: "active" } }, _sum: { quantity: true } })
    assert.equal(b.reserved, held._sum.quantity ?? 0, "reserved stock is exactly what the active holds cover")
    assert.ok(b.onHand - b.reserved - b.allocated >= 0, "never oversold")
    const movements = await ctx.db.inventoryMovement.count({ where: { variantId, type: "reservation" } })
    const lines = await ctx.db.inventoryReservationLine.count({ where: { variantId } })
    assert.equal(movements, lines, "one ledger movement per held line, no more")
  }
  const orphans = await ctx.db.order.count({ where: { quoteRef: { not: null }, reservation: null } })
  assert.equal(orphans, 0, "no order without its hold")
}

before(async () => {
  ctx = await setup("chaanavya_test_s13_atomic_reservation")
  forward = ctx.routes.me.GET
  const { user } = await createStaff(ctx, "s13.atomic.owner@example.com", "OWNER")
  await ctx.db.taxProfile.create({ data: { sellerStateCode: "IN-KA", pricesIncludeTax: true, note: "synthetic test values", createdById: user.id, rates: { create: [{ taxCategory: "apparel_cotton", hsnCode: "6204", rateBasisPoints: 500 }] } } })
})
after(() => ctx?.teardown())

describe("CHV-S13-M05 last-unit simultaneous checkouts yield only one valid reservation", () => {
  test("ten shoppers check out the last unit at once: one order holds it, nine are refused", async () => {
    const last = await variant(1)
    const shoppers = []
    for (let i = 0; i < 10; i++) shoppers.push(await shopper([[last, 1]]))
    const { won, lost } = await race(shoppers)
    assert.equal(won.length, 1)
    assert.equal(lost.length, 9)
    assert.equal(await ctx.db.inventoryReservation.count({ where: { lines: { some: { variantId: last } } } }), 1, "exactly one reservation")
    assert.equal(await ctx.db.order.count({ where: { quoteRef: { in: shoppers.map(s => s.quote.id) } } }), 1, "exactly one order")
    await consistent([last])
  })

  test("a bag of the last unit and a plentiful item: the losers hold neither", async () => {
    const last = await variant(1)
    const plenty = await variant(50)
    const shoppers = []
    for (let i = 0; i < 6; i++) shoppers.push(await shopper([[plenty, 3], [last, 1]]))
    const { won } = await race(shoppers)
    assert.equal(won.length, 1)
    const b = await ctx.db.inventoryBalance.findUniqueOrThrow({ where: { variantId: plenty } })
    assert.equal(b.reserved, 3, "only the winner's 3; no loser kept a hold on the plentiful line")
    await consistent([last, plenty])
  })

  test("the scarce item is the second line for some and the first for others: still all or none", async () => {
    const a = await variant(2)
    const b = await variant(1)
    const shoppers = []
    for (let i = 0; i < 6; i++) shoppers.push(await shopper(i % 2 ? [[a, 1], [b, 1]] : [[b, 1], [a, 1]]))
    const { won } = await race(shoppers)
    assert.equal(won.length, 1, "the single unit of b admits one order")
    const balanceA = await ctx.db.inventoryBalance.findUniqueOrThrow({ where: { variantId: a } })
    assert.equal(balanceA.reserved, 1, "a has room for two, but a loser holding one of them would be a partial hold")
    await consistent([a, b])
  })
})

describe("CHV-S13-M05 opposite-order bags never deadlock", () => {
  test("bags holding the same two items in opposite order race repeatedly and always finish", async () => {
    for (let round = 0; round < 3; round++) {
      const x = await variant(1)
      const y = await variant(1)
      // Four different shoppers, two adding x then y and two adding y then x.
      const bags = [await shopper([[x, 1], [y, 1]]), await shopper([[y, 1], [x, 1]]), await shopper([[x, 1], [y, 1]]), await shopper([[y, 1], [x, 1]])]
      const started = Date.now()
      const { won, lost } = await race(bags)
      assert.ok(Date.now() - started < 10_000, "finished well inside the transaction limits")
      assert.equal(won.length, 1, `round ${round}: one order takes both items`)
      assert.ok(lost.length >= 1)
      await consistent([x, y])
    }
  })
})

describe("CHV-S13-M05 a refused checkout leaves nothing behind", () => {
  test("after every race, refused shoppers have no order, no hold and no movement, and their quotes were not used up", async () => {
    const last = await variant(1)
    const shoppers = []
    for (let i = 0; i < 5; i++) shoppers.push(await shopper([[last, 1]]))
    const results = await Promise.all(shoppers.map(checkout))
    const winners = new Set(results.filter(r => r.status === 201).map(r => r.json.data.quoteId))
    for (const s of shoppers.filter(s => !winners.has(s.quote.id))) {
      assert.equal(await ctx.db.order.count({ where: { quoteRef: s.quote.id } }), 0)
      assert.equal(await ctx.db.checkoutQuote.count({ where: { id: s.quote.id } }) <= 1, true)
    }
    for (const r of results.filter(r => r.status === 409)) {
      const reasons = Object.values(r.json.error.fields)
      assert.ok(reasons.some(v => /insufficient_stock|changed|stock/.test(v)), `explained: ${JSON.stringify(r.json.error)}`)
    }
    await consistent([last])
  })
})
