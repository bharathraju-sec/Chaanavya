// CHV-S11-M06: removing a line and clearing the bag. Both are scoped to the caller's own bag and are
// idempotent: repeating them (one after another or all at once) changes the bag once and never
// corrupts it, and another shopper's lines are never touched. Real API in-process behind the forwarder.
import { after, before, describe, test } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { call, Jar, newIp, setup, signInCustomer } from "../auth/helpers.mjs"

let ctx, forward
const v = {}

async function variant(handle, pricePaise) {
  const created = await ctx.db.product.create({
    data: { handle, title: `Fixture ${handle}`, status: "active", publishedAt: new Date(), variants: { create: [{ sku: `${handle}-m`, title: "M", optionKey: "size:m", pricePaise }] } },
    include: { variants: true },
  })
  await ctx.db.inventoryBalance.create({ data: { variantId: created.variants[0].id, onHand: 500, lastCountedAt: new Date() } })
  return { id: created.variants[0].id, pricePaise: Number(pricePaise) }
}

const add = (jar, variantId, quantity = 1, key = randomUUID()) => call(forward, "/api/cart/lines", { method: "POST", jar, body: { variantId, quantity }, headers: { "idempotency-key": key }, ip: newIp() })
const removeLine = (jar, lineId, options = {}) => call(forward, `/api/cart/lines/${encodeURIComponent(lineId)}`, { method: "DELETE", jar, ip: newIp(), ...options })
const clear = (jar, options = {}) => call(forward, "/api/cart", { method: "DELETE", jar, ip: newIp(), ...options })
const bag = async jar => (await call(forward, "/api/cart", { jar, ip: newIp() })).json.data
const guestCookie = response => response.headers.getSetCookie().find(c => c.startsWith("chaanavya_guest="))

/** A bag with one of each of the three fixtures (quantities 1, 2, 3). */
async function fullBag(jar = new Jar()) {
  await add(jar, v.top.id, 1)
  await add(jar, v.skirt.id, 2)
  const res = await add(jar, v.bangle.id, 3)
  return { jar, cart: res.json.data, line: Object.fromEntries(res.json.data.lines.map(l => [l.handle.replace("fixture-", ""), l])) }
}

/** Database-level health of a cart: every quantity in range, one line per variant, lines match the API. */
async function assertHealthy(cartId, apiBag) {
  const rows = await ctx.db.cartLine.findMany({ where: { cartId } })
  for (const r of rows) assert.ok(r.quantity >= 1 && r.quantity <= 10, `quantity ${r.quantity}`)
  assert.equal(new Set(rows.map(r => r.variantId)).size, rows.length, "one line per variant")
  if (apiBag) {
    assert.deepEqual(rows.map(r => r.id).sort(), apiBag.lines.map(l => l.id).sort())
    const live = apiBag.lines.reduce((sum, l) => sum + l.unitPrice.amountPaise * l.quantity, 0)
    assert.equal(apiBag.subtotal.amountPaise, live, "subtotal matches the lines")
  }
}

before(async () => {
  ctx = await setup("chaanavya_test_s11_remove_clear")
  forward = ctx.routes.me.GET
  v.top = await variant("fixture-top", 120000n)
  v.skirt = await variant("fixture-skirt", 180000n)
  v.bangle = await variant("fixture-bangle", 60000n)
})
after(() => ctx?.teardown())

describe("CHV-S11-M06 remove and clear", () => {
  test("removing a line takes out only that line and recomputes the subtotal", async () => {
    const { jar, cart, line } = await fullBag()
    const res = await removeLine(jar, line.skirt.id)
    assert.equal(res.status, 200)
    assert.deepEqual(res.json.data.lines.map(l => l.handle).sort(), ["fixture-bangle", "fixture-top"])
    assert.equal(res.json.data.subtotal.amountPaise, v.top.pricePaise + 3 * v.bangle.pricePaise)
    assert.equal(res.json.data.revision, cart.revision + 1)
    await assertHealthy(cart.id, res.json.data)
  })

  test("removing the same line again, several times, changes nothing and leaves the bag intact", async () => {
    const { jar, cart, line } = await fullBag()
    const first = (await removeLine(jar, line.top.id)).json.data
    for (let i = 0; i < 3; i++) {
      const again = await removeLine(jar, line.top.id)
      assert.equal(again.status, 200, "a repeat is not an error")
      assert.deepEqual(again.json.data, first, "same bag, same revision")
    }
    assert.equal(first.revision, cart.revision + 1)
    await assertHealthy(cart.id, await bag(jar))
  })

  test("the same removal sent many times at once applies once and corrupts nothing", async () => {
    const { jar, cart, line } = await fullBag()
    const results = await Promise.all(Array.from({ length: 6 }, () => removeLine(jar, line.bangle.id)))
    for (const r of results) assert.equal(r.status, 200, JSON.stringify(r.json))
    const after = await bag(jar)
    assert.deepEqual(after.lines.map(l => l.handle).sort(), ["fixture-skirt", "fixture-top"])
    assert.equal(after.revision, cart.revision + 1, "one change, however many requests")
    await assertHealthy(cart.id, after)
  })

  test("removing never reaches another shopper's line: the caller's own bag comes back unchanged", async () => {
    const victim = await fullBag()
    const guest = await fullBag()
    const customer = await signInCustomer(ctx, "remove.other@example.com")
    await add(customer, v.top.id)
    for (const intruder of [guest.jar, customer]) {
      const own = await bag(intruder)
      const res = await removeLine(intruder, victim.line.skirt.id)
      assert.equal(res.status, 200)
      assert.deepEqual(res.json.data, own, "the intruder sees only their own, unchanged bag")
      assert.ok(!JSON.stringify(res.json).includes(victim.cart.id))
    }
    const anonymous = await removeLine(new Jar(), victim.line.skirt.id)
    assert.equal(anonymous.status, 200)
    assert.equal(anonymous.json.data, null)
    const after = await bag(victim.jar)
    assert.equal(after.lines.length, 3, "nothing of the victim's was removed")
    assert.equal(after.revision, victim.cart.revision)
  })

  test("a malformed line id is 404; a shopper with no bag gets null and no guest session", async () => {
    const { jar } = await fullBag()
    for (const id of ["not-a-uuid", "1 OR 1=1", "%00"]) assert.equal((await removeLine(jar, id)).status, 404, id)
    const sessions = await ctx.db.guestSession.count()
    for (const res of [await removeLine(new Jar(), randomUUID()), await clear(new Jar())]) {
      assert.equal(res.status, 200)
      assert.equal(res.json.data, null)
      assert.equal(guestCookie(res.response), undefined)
    }
    assert.equal(await ctx.db.guestSession.count(), sessions)
  })

  test("clearing empties the bag but keeps it; clearing again changes nothing", async () => {
    const { jar, cart } = await fullBag()
    const cleared = await clear(jar)
    assert.equal(cleared.status, 200)
    assert.equal(cleared.json.data.id, cart.id, "the same bag, now empty")
    assert.deepEqual(cleared.json.data.lines, [])
    assert.equal(cleared.json.data.subtotal.amountPaise, 0)
    assert.equal(cleared.json.data.revision, cart.revision + 1)
    for (let i = 0; i < 2; i++) assert.deepEqual((await clear(jar)).json.data, cleared.json.data)
    const results = await Promise.all(Array.from({ length: 4 }, () => clear(jar)))
    for (const r of results) assert.deepEqual(r.json.data, cleared.json.data)
    assert.equal(await ctx.db.cartLine.count({ where: { cartId: cart.id } }), 0)
  })

  test("clearing touches only the caller's bag", async () => {
    const mine = await fullBag()
    const theirs = await fullBag()
    await clear(mine.jar)
    const after = await bag(theirs.jar)
    assert.equal(after.lines.length, 3)
    assert.equal(after.revision, theirs.cart.revision)
  })

  test("an add replayed after a clear is not applied again, while a new add works", async () => {
    const jar = new Jar()
    const key = randomUUID()
    await add(jar, v.top.id, 2, key)
    await clear(jar)
    const replay = await add(jar, v.top.id, 2, key)
    assert.equal(replay.status, 200)
    assert.deepEqual(replay.json.data.lines, [], "the old add stays undone")
    const fresh = await add(jar, v.top.id, 1)
    assert.equal(fresh.json.data.lines[0].quantity, 1)
  })

  test("clears, removals and adds racing on one bag leave it consistent", async () => {
    const { jar, cart, line } = await fullBag()
    const results = await Promise.all([clear(jar), add(jar, v.top.id, 2), removeLine(jar, line.skirt.id), add(jar, v.bangle.id, 1), clear(jar), removeLine(jar, line.top.id), add(jar, v.skirt.id, 4)])
    for (const r of results) assert.equal(r.status, 200, JSON.stringify(r.json))
    const after = await bag(jar)
    assert.equal(after.id, cart.id)
    assert.ok(after.revision > cart.revision && after.revision <= cart.revision + results.length)
    await assertHealthy(cart.id, after)
  })

  test("a cross-site request cannot remove or clear", async () => {
    const { jar, cart, line } = await fullBag()
    const crossSite = { origin: "https://evil.example", headers: { "sec-fetch-site": "cross-site" } }
    assert.equal((await removeLine(jar, line.top.id, crossSite)).status, 403)
    assert.equal((await clear(jar, crossSite)).status, 403)
    const after = await bag(jar)
    assert.equal(after.lines.length, 3)
    assert.equal(after.revision, cart.revision)
  })

  test("after a removal the line is gone for every route: changing it is 404, removing it again is harmless", async () => {
    const { jar, line } = await fullBag()
    await removeLine(jar, line.top.id)
    assert.equal((await call(forward, `/api/cart/lines/${line.top.id}`, { method: "PATCH", jar, body: { quantity: 2 }, ip: newIp() })).status, 404)
    assert.equal((await removeLine(jar, line.top.id)).status, 200)
  })
})
