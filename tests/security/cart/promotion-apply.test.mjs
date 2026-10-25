// CHV-S11-M10: applying a promo code to the bag. One code per bag (a valid new code replaces the
// old one, owner decision 25 October 2026), applied to every counted line including reduced items;
// the discount and total are computed on the server, checked again on every read, never above the
// subtotal, and the same bag always gives the same totals. Real API in-process behind the forwarder.
import { after, before, describe, test } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { call, Jar, newIp, orderData, setup } from "../auth/helpers.mjs"

let ctx, forward
const v = {}
const DAY = 86_400_000

async function variant(handle, { pricePaise = 100000n, compareAtPricePaise = null } = {}) {
  const created = await ctx.db.product.create({
    data: { handle, title: `Fixture ${handle}`, status: "active", publishedAt: new Date(), variants: { create: [{ sku: `${handle}-m`, title: "M", optionKey: "size:m", pricePaise, compareAtPricePaise }] } },
    include: { variants: true },
  })
  await ctx.db.inventoryBalance.create({ data: { variantId: created.variants[0].id, onHand: 500, lastCountedAt: new Date() } })
  return { id: created.variants[0].id, productId: created.id, pricePaise: Number(pricePaise) }
}
const code = (c, data) => ctx.db.promotion.create({ data: { code: c, startsAt: new Date(Date.now() - DAY), active: true, ...data } })

const add = (jar, variantId, quantity = 1) => call(forward, "/api/cart/lines", { method: "POST", jar, body: { variantId, quantity }, headers: { "idempotency-key": randomUUID() }, ip: newIp() })
const apply = (jar, body, options = {}) => call(forward, "/api/cart/promotion", { method: "POST", jar, body: typeof body === "string" ? { code: body } : body, ip: newIp(), ...options })
const unapply = jar => call(forward, "/api/cart/promotion", { method: "DELETE", jar, ip: newIp() })
const bag = async jar => (await call(forward, "/api/cart", { jar, ip: newIp() })).json.data
const setQty = (jar, lineId, quantity) => call(forward, `/api/cart/lines/${lineId}`, { method: "PATCH", jar, body: { quantity }, ip: newIp() })
const totals = b => ({ subtotal: b.subtotal.amountPaise, discount: b.discount.amountPaise, total: b.total.amountPaise })

/** A guest bag holding the given [variant, quantity] pairs. */
async function bagOf(items, jar = new Jar()) {
  for (const [item, quantity] of items) assert.equal((await add(jar, item.id, quantity)).status, 200)
  return jar
}

before(async () => {
  ctx = await setup("chaanavya_test_s11_promotion_apply")
  forward = ctx.routes.me.GET
  v.kurta = await variant("fixture-kurta", { pricePaise: 249999n })
  v.dupatta = await variant("fixture-dupatta", { pricePaise: 89900n })
  v.sale = await variant("fixture-sale", { pricePaise: 150000n, compareAtPricePaise: 200000n })
  await code("TENOFF", { kind: "percent", percentBasisPoints: 1000 })
  await code("FIFTEEN", { kind: "percent", percentBasisPoints: 1500 })
  await code("FLAT500", { kind: "fixed_amount", amountOffPaise: 50000n })
  await code("HUGE", { kind: "fixed_amount", amountOffPaise: 100000000n })
  await code("MIN5000", { kind: "percent", percentBasisPoints: 2000, minSubtotalPaise: 500000n })
  await code("OLDCODE", { kind: "percent", percentBasisPoints: 1000, startsAt: new Date(Date.now() - 10 * DAY), endsAt: new Date(Date.now() - DAY) })
  await code("LATER", { kind: "percent", percentBasisPoints: 1000, startsAt: new Date(Date.now() + DAY) })
  await code("OFFCODE", { kind: "percent", percentBasisPoints: 1000, active: false })
})
after(() => ctx?.teardown())

describe("CHV-S11-M10 coupon application", () => {
  test("a percentage code: discount and total come from the server, rounded down to the paisa", async () => {
    const jar = await bagOf([[v.kurta, 1], [v.dupatta, 2]])
    const res = await apply(jar, " tenoff ")
    assert.equal(res.status, 200, JSON.stringify(res.json))
    const subtotal = 249999 + 2 * 89900
    assert.deepEqual(totals(res.json.data), { subtotal, discount: Math.floor(subtotal / 10), total: subtotal - Math.floor(subtotal / 10) })
    assert.deepEqual(res.json.data.promotion, { code: "TENOFF", applied: true })
  })

  test("a fixed-amount code never takes off more than the subtotal, and the total is never negative", async () => {
    const small = await bagOf([[v.dupatta, 1]])
    assert.deepEqual(totals((await apply(small, "HUGE")).json.data), { subtotal: 89900, discount: 89900, total: 0 })
    const big = await bagOf([[v.kurta, 1]])
    assert.deepEqual(totals((await apply(big, "FLAT500")).json.data), { subtotal: 249999, discount: 50000, total: 199999 })
  })

  test("totals are recomputed on every change and read, and the same bag always gives the same totals", async () => {
    const jar = await bagOf([[v.kurta, 2]])
    await apply(jar, "FIFTEEN")
    const line = (await bag(jar)).lines[0]
    for (const quantity of [3, 1, 5]) {
      const b = (await setQty(jar, line.id, quantity)).json.data
      const subtotal = quantity * 249999
      assert.deepEqual(totals(b), { subtotal, discount: Math.floor((subtotal * 1500) / 10000), total: subtotal - Math.floor((subtotal * 1500) / 10000) })
    }
    const reads = await Promise.all(Array.from({ length: 5 }, () => bag(jar)))
    for (const r of reads) assert.deepEqual(totals(r), totals(reads[0]))
    // The same items added in a different order give exactly the same totals.
    const one = await bagOf([[v.kurta, 2], [v.dupatta, 1], [v.sale, 3]])
    const two = await bagOf([[v.sale, 3], [v.dupatta, 1], [v.kurta, 2]])
    await apply(one, "FIFTEEN")
    await apply(two, "FIFTEEN")
    assert.deepEqual(totals(await bag(one)), totals(await bag(two)))
  })

  test("reduced items are discounted too (owner decision)", async () => {
    const jar = await bagOf([[v.sale, 2]])
    const b = (await apply(jar, "TENOFF")).json.data
    assert.deepEqual(totals(b), { subtotal: 300000, discount: 30000, total: 270000 })
  })

  test("expired, not started, switched-off and unknown codes are refused and the bag is unchanged", async () => {
    const jar = await bagOf([[v.kurta, 1]])
    const before = await bag(jar)
    for (const [c, reason] of [["OLDCODE", "expired"], ["LATER", "not_started"], ["OFFCODE", "not_found"], ["NOPE123", "not_found"], ["x", "not_found"], ["TENOFF' OR 1=1", "not_found"]]) {
      const res = await apply(jar, c)
      assert.equal(res.status, 400, c)
      assert.equal(res.json.error.fields.code, reason, c)
    }
    assert.equal((await apply(jar, { code: 42 })).json.error.fields.code, "not_found")
    const after = await bag(jar)
    assert.equal(after.promotion, null)
    assert.equal(after.revision, before.revision)
  })

  test("one code per bag: a valid new code replaces the old one, and discounts never stack", async () => {
    const jar = await bagOf([[v.kurta, 2]])
    await apply(jar, "TENOFF")
    const replaced = (await apply(jar, "FLAT500")).json.data
    assert.deepEqual(replaced.promotion, { code: "FLAT500", applied: true })
    assert.equal(replaced.discount.amountPaise, 50000, "only the new code's discount, not both")
    const refused = await apply(jar, "OLDCODE")
    assert.equal(refused.status, 400)
    assert.deepEqual((await bag(jar)).promotion, { code: "FLAT500", applied: true }, "an invalid new code leaves the old one in place")
    const again = await apply(jar, "flat500")
    assert.equal(again.json.data.revision, replaced.revision, "applying the code already on the bag changes nothing")
  })

  test("a bag below a code's minimum spend cannot take it", async () => {
    const jar = await bagOf([[v.kurta, 2]])
    const res = await apply(jar, "MIN5000")
    assert.equal(res.status, 400, "499,998 paise is below the 500,000 minimum")
    assert.equal(res.json.error.fields.code, "minimum_not_met")
  })

  test("a qualifying bag keeps a minimum-spend code while it qualifies and loses only the discount when it does not", async () => {
    const jar = await bagOf([[v.kurta, 3]])
    const applied = (await apply(jar, "MIN5000")).json.data
    assert.equal(applied.discount.amountPaise, Math.floor((749997 * 2000) / 10000))
    const line = applied.lines[0]
    const below = (await setQty(jar, line.id, 1)).json.data
    assert.deepEqual(below.promotion, { code: "MIN5000", applied: false, reason: "minimum_not_met" })
    assert.deepEqual(totals(below), { subtotal: 249999, discount: 0, total: 249999 })
    const back = (await setQty(jar, line.id, 3)).json.data
    assert.equal(back.promotion.applied, true)
    assert.equal(back.discount.amountPaise, Math.floor((749997 * 2000) / 10000))
    // The code expires while on the bag: the next read gives no discount and says why.
    await ctx.db.promotion.update({ where: { code: "MIN5000" }, data: { endsAt: new Date(Date.now() - 1000), startsAt: new Date(Date.now() - DAY) } })
    const expired = await bag(jar)
    assert.deepEqual(expired.promotion, { code: "MIN5000", applied: false, reason: "expired" })
    assert.equal(expired.discount.amountPaise, 0)
  })

  test("items no longer on sale are left out of the discount base", async () => {
    const gone = await variant("fixture-withdrawn", { pricePaise: 300000n })
    const jar = await bagOf([[v.dupatta, 1], [gone, 1]])
    await apply(jar, "TENOFF")
    await ctx.db.product.update({ where: { id: gone.productId }, data: { status: "archived" } })
    assert.deepEqual(totals(await bag(jar)), { subtotal: 89900, discount: 8990, total: 80910 })
  })

  test("a per-customer limit is enforced through the bag, for guests by guest session", async () => {
    const p = await code("ONCE", { kind: "percent", percentBasisPoints: 1000, perCustomerLimit: 1 })
    const jar = await bagOf([[v.kurta, 1]])
    const cart = await ctx.db.cart.findFirstOrThrow({ where: { id: (await bag(jar)).id } })
    assert.equal((await apply(jar, "ONCE")).status, 200)
    await unapply(jar)
    await ctx.db.order.create({ data: orderData({ email: "once.guest@example.com", guestSessionId: cart.guestSessionId, promotionId: p.id, status: "confirmed" }) })
    const res = await apply(jar, "ONCE")
    assert.equal(res.status, 400)
    assert.equal(res.json.error.fields.code, "per_customer_limit_reached")
    assert.equal((await apply(await bagOf([[v.kurta, 1]]), "ONCE")).status, 200, "another guest is unaffected")
  })

  test("a discount or total sent by the browser is ignored", async () => {
    const jar = await bagOf([[v.kurta, 1]])
    const res = await apply(jar, { code: "TENOFF", discount: { amountPaise: 249999 }, discountPaise: 249999, total: 1, percentBasisPoints: 10000 })
    assert.deepEqual(totals(res.json.data), { subtotal: 249999, discount: 24999, total: 225000 })
  })

  test("removing the code is idempotent and restores the full total", async () => {
    const jar = await bagOf([[v.kurta, 1]])
    await apply(jar, "TENOFF")
    const removed = (await unapply(jar)).json.data
    assert.equal(removed.promotion, null)
    assert.deepEqual(totals(removed), { subtotal: 249999, discount: 0, total: 249999 })
    const again = (await unapply(jar)).json.data
    assert.equal(again.revision, removed.revision)
  })

  test("a code is applied only to the caller's own bag; no bag means 404 and no guest session", async () => {
    const sessions = await ctx.db.guestSession.count()
    const res = await apply(new Jar(), "TENOFF")
    assert.equal(res.status, 404)
    assert.equal(await ctx.db.guestSession.count(), sessions)
    assert.equal((await unapply(new Jar())).json.data, null)
    const mine = await bagOf([[v.kurta, 1]])
    const theirs = await bagOf([[v.dupatta, 1]])
    await apply(mine, "TENOFF")
    assert.equal((await bag(theirs)).promotion, null)
    const crossSite = await apply(theirs, "TENOFF", { origin: "https://evil.example", headers: { "sec-fetch-site": "cross-site" } })
    assert.equal(crossSite.status, 403)
    assert.equal((await bag(theirs)).promotion, null)
  })

  test("guessing codes is rate limited: the 11th try in a minute from one address is refused", async () => {
    const jar = await bagOf([[v.kurta, 1]])
    const ip = newIp()
    const statuses = []
    for (let i = 0; i < 11; i++) statuses.push((await apply(jar, `GUESS${i}X`, { ip })).status)
    assert.deepEqual(statuses.slice(0, 10), Array(10).fill(400))
    assert.equal(statuses[10], 429)
  })

  test("over many random bags, the discount is whole paise, never above the subtotal, and total = subtotal - discount", async () => {
    let seed = 1110
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
    for (let round = 0; round < 8; round++) {
      const items = [v.kurta, v.dupatta, v.sale].filter(() => random() < 0.8).map(item => [item, 1 + Math.floor(random() * 10)])
      if (items.length === 0) continue
      const jar = await bagOf(items)
      for (const c of ["TENOFF", "FIFTEEN", "FLAT500", "HUGE"]) {
        const b = (await apply(jar, c)).json.data
        const { subtotal, discount, total } = totals(b)
        assert.ok(Number.isInteger(discount) && discount >= 0 && discount <= subtotal, `${c}: ${discount} of ${subtotal}`)
        assert.equal(total, subtotal - discount)
      }
    }
  })
})
