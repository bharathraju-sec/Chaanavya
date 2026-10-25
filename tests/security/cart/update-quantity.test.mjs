// CHV-S11-M05: changing a line's quantity. An invalid quantity can never be stored: the API refuses
// it and leaves the line and the cart's revision as they were, and the database refuses it too.
// Only the owner can change a line; raising needs the item on sale and enough free stock, lowering
// always works; the bag's totals are recomputed on the server. Real API in-process behind the forwarder.
import { after, before, describe, test } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { call, Jar, newIp, setup, signInCustomer } from "../auth/helpers.mjs"

let ctx, forward
const v = {}

async function variant(handle, { pricePaise = 150000n, onHand = 30 } = {}) {
  const created = await ctx.db.product.create({
    data: { handle, title: `Fixture ${handle}`, status: "active", publishedAt: new Date(), variants: { create: [{ sku: `${handle}-m`, title: "M", optionKey: "size:m", pricePaise }] } },
    include: { variants: true },
  })
  const id = created.variants[0].id
  await ctx.db.inventoryBalance.create({ data: { variantId: id, onHand, lastCountedAt: new Date() } })
  return { id, productId: created.id, pricePaise: Number(pricePaise) }
}

const add = (jar, variantId, quantity = 1) => call(forward, "/api/cart/lines", { method: "POST", jar, body: { variantId, quantity }, headers: { "idempotency-key": randomUUID() }, ip: newIp() })
const setQty = (jar, lineId, body) => call(forward, `/api/cart/lines/${encodeURIComponent(lineId)}`, { method: "PATCH", jar, body, ip: newIp() })
const bag = async jar => (await call(forward, "/api/cart", { jar, ip: newIp() })).json.data
const stored = id => ctx.db.cartLine.findUnique({ where: { id } })

/** A fresh bag holding `quantity` of the variant; returns the jar, line and cart. */
async function bagWith(variantId, quantity = 2, jar = new Jar()) {
  const res = await add(jar, variantId, quantity)
  assert.equal(res.status, 200, JSON.stringify(res.json))
  return { jar, line: res.json.data.lines.find(l => l.variantId === variantId), cart: res.json.data }
}

before(async () => {
  ctx = await setup("chaanavya_test_s11_update_quantity")
  forward = ctx.routes.me.GET
  v.shirt = await variant("fixture-shirt", { pricePaise: 150000n })
  v.belt = await variant("fixture-belt", { pricePaise: 45000n })
  v.scarce = await variant("fixture-scarce", { onHand: 4 })
})
after(() => ctx?.teardown())

describe("CHV-S11-M05 update quantity", () => {
  test("an invalid quantity is refused and nothing is stored: the line and the revision stay as they were", async () => {
    const { jar, line, cart } = await bagWith(v.shirt.id, 2)
    const invalid = [{}, { quantity: -1 }, { quantity: 11 }, { quantity: 99 }, { quantity: 1.5 }, { quantity: "3" }, { quantity: null }, { quantity: true }, { quantity: [3] }, { quantity: { value: 3 } }, { quantity: 1e309 }, { quantity: Number.MAX_SAFE_INTEGER }]
    for (const body of invalid) {
      const res = await setQty(jar, line.id, body)
      assert.equal(res.status, 400, JSON.stringify(body))
      assert.equal(res.json.error.fields.quantity, "invalid")
    }
    assert.equal((await setQty(jar, line.id, "not json")).status, 400, "a body that is not JSON")
    assert.equal((await stored(line.id)).quantity, 2)
    assert.equal((await bag(jar)).revision, cart.revision, "no refused change bumped the revision")
  })

  test("the database refuses an out-of-range quantity even if the API were bypassed", async () => {
    const { line } = await bagWith(v.belt.id, 1)
    for (const quantity of [0, -3, 100]) {
      await assert.rejects(ctx.db.cartLine.update({ where: { id: line.id }, data: { quantity } }), /cart_line_quantity_range|check constraint/i, String(quantity))
    }
    assert.equal((await stored(line.id)).quantity, 1)
  })

  test("valid quantities from 1 to 10 are stored, and the bag's totals are recomputed on the server", async () => {
    const jar = new Jar()
    await add(jar, v.belt.id, 1)
    const { line } = await bagWith(v.shirt.id, 1, jar)
    for (const quantity of [1, 4, 10, 3]) {
      const res = await setQty(jar, line.id, { quantity, price: 1, subtotal: { amountPaise: 1 } })
      assert.equal(res.status, 200)
      const shirt = res.json.data.lines.find(l => l.id === line.id)
      assert.equal(shirt.quantity, quantity)
      assert.equal(shirt.unitPrice.amountPaise, v.shirt.pricePaise, "a price in the request is ignored")
      assert.equal(res.json.data.subtotal.amountPaise, quantity * v.shirt.pricePaise + v.belt.pricePaise)
      assert.equal((await stored(line.id)).quantity, quantity)
    }
  })

  test("0 removes the line, and the subtotal drops with it", async () => {
    const jar = new Jar()
    await add(jar, v.belt.id, 2)
    const { line } = await bagWith(v.shirt.id, 3, jar)
    const res = await setQty(jar, line.id, { quantity: 0 })
    assert.equal(res.status, 200)
    assert.deepEqual(res.json.data.lines.map(l => l.variantId), [v.belt.id])
    assert.equal(res.json.data.subtotal.amountPaise, 2 * v.belt.pricePaise)
    assert.equal(await stored(line.id), null)
  })

  test("only the owner can change a line: another guest, another account or no session gets 404", async () => {
    const { jar, line, cart } = await bagWith(v.shirt.id, 2)
    const customer = await signInCustomer(ctx, "qty.other@example.com")
    const otherGuest = new Jar()
    await add(otherGuest, v.belt.id)
    for (const intruder of [otherGuest, customer, new Jar()]) {
      for (const quantity of [0, 1, 5]) assert.equal((await setQty(intruder, line.id, { quantity })).status, 404)
    }
    for (const id of [randomUUID(), "not-a-uuid", `${line.id}'--`]) assert.equal((await setQty(jar, id, { quantity: 1 })).status, 404, id)
    assert.equal((await stored(line.id)).quantity, 2)
    assert.equal((await bag(jar)).revision, cart.revision)
  })

  test("raising needs free stock now; lowering always works", async () => {
    // fixture-scarce: 4 on hand.
    const { jar, line } = await bagWith(v.scarce.id, 2)
    assert.equal((await setQty(jar, line.id, { quantity: 4 })).status, 200)
    const over = await setQty(jar, line.id, { quantity: 5 })
    assert.equal(over.status, 409)
    assert.deepEqual(over.json.error.fields, { quantity: "exceeds_stock" })
    // Another order takes stock: the bag now holds more than is free. Lowering still works; raising does not.
    await ctx.db.inventoryBalance.update({ where: { variantId: v.scarce.id }, data: { reserved: 3 } })
    assert.equal((await setQty(jar, line.id, { quantity: 3 })).status, 200, "lowering is never blocked by stock")
    assert.equal((await setQty(jar, line.id, { quantity: 3 })).status, 200)
    const raise = await setQty(jar, line.id, { quantity: 4 })
    assert.equal(raise.status, 409)
    assert.equal((await stored(line.id)).quantity, 3)
    await ctx.db.inventoryBalance.update({ where: { variantId: v.scarce.id }, data: { reserved: 0 } })
  })

  test("an item taken off sale can be lowered or removed, but not raised", async () => {
    const item = await variant("fixture-withdrawn")
    const { jar, line } = await bagWith(item.id, 3)
    await ctx.db.product.update({ where: { id: item.productId }, data: { status: "archived" } })
    const raise = await setQty(jar, line.id, { quantity: 4 })
    assert.equal(raise.status, 409)
    assert.equal(raise.json.error.fields.quantity, "unavailable")
    const lower = await setQty(jar, line.id, { quantity: 1 })
    assert.equal(lower.status, 200)
    assert.equal(lower.json.data.subtotal.amountPaise, 0, "still flagged and not counted")
    assert.equal((await setQty(jar, line.id, { quantity: 0 })).json.data.lines.length, 0)
  })

  test("setting the same quantity again changes nothing; a change to a removed line stays refused", async () => {
    const { jar, line } = await bagWith(v.shirt.id, 2)
    const first = await setQty(jar, line.id, { quantity: 5 })
    const replay = await setQty(jar, line.id, { quantity: 5 })
    assert.deepEqual(replay.json.data, first.json.data, "same bag, same revision")
    await setQty(jar, line.id, { quantity: 0 })
    assert.equal((await setQty(jar, line.id, { quantity: 5 })).status, 404)
  })

  test("concurrent changes apply one after another and never pass the free stock", async () => {
    const scarce = await variant("fixture-race-qty", { onHand: 5 })
    const { jar, line, cart } = await bagWith(scarce.id, 1)
    const results = await Promise.all([setQty(jar, line.id, { quantity: 5 }), add(jar, scarce.id, 3), setQty(jar, line.id, { quantity: 4 }), add(jar, scarce.id, 2)])
    for (const r of results) assert.ok([200, 409].includes(r.status), JSON.stringify(r.json))
    const final = await bag(jar)
    const quantity = final.lines.find(l => l.id === line.id).quantity
    assert.ok(quantity >= 1 && quantity <= 5, `stored ${quantity}`)
    // Each applied change bumps the revision once (a change to the same quantity bumps nothing).
    const applied = results.filter(r => r.status === 200).length
    assert.ok(applied >= 1)
    assert.ok(final.revision > cart.revision && final.revision <= cart.revision + applied, `revision ${cart.revision} -> ${final.revision} after ${applied} applied`)
  })
})
