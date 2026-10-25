// CHV-S11-M04: adding to the bag. The browser chooses only a variant and a quantity; whatever price
// it sends is ignored, and the bag always shows the catalogue's current price. Variants and
// quantities are validated, availability is read on the server at the moment of the add, and a
// retried add (same Idempotency-Key) never counts twice. Real API in-process behind the forwarder.
import { after, before, describe, test } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { call, Jar, newIp, setup } from "../auth/helpers.mjs"

let ctx, forward
const v = {}

async function variant(handle, { pricePaise = 349900n, onHand = 30, reserved = 0, counted = true, status = "active", published = true } = {}) {
  const created = await ctx.db.product.create({
    data: { handle, title: `Fixture ${handle}`, status, publishedAt: published ? new Date() : null, variants: { create: [{ sku: `${handle}-m`, title: "M", optionKey: "size:m", pricePaise }] } },
    include: { variants: true },
  })
  const id = created.variants[0].id
  await ctx.db.inventoryBalance.create({ data: { variantId: id, onHand, reserved, lastCountedAt: counted ? new Date() : null } })
  return { id, productId: created.id, pricePaise: Number(pricePaise), title: created.title }
}

const post = (jar, body, key = randomUUID()) => call(forward, "/api/cart/lines", { method: "POST", jar, body, headers: key === null ? {} : { "idempotency-key": key }, ip: newIp() })
const add = (jar, variantId, quantity = 1, key) => post(jar, { variantId, quantity }, key)
const bag = async jar => (await call(forward, "/api/cart", { jar, ip: newIp() })).json.data
const guestCookie = response => response.headers.getSetCookie().find(c => c.startsWith("chaanavya_guest="))

before(async () => {
  ctx = await setup("chaanavya_test_s11_add_item")
  forward = ctx.routes.me.GET
  v.gown = await variant("fixture-gown", { pricePaise: 1299900n })
  v.few = await variant("fixture-few", { onHand: 3, reserved: 1 })
  v.race = await variant("fixture-race", { onHand: 3 })
  v.uncounted = await variant("fixture-uncounted", { counted: false })
  v.draft = await variant("fixture-draft", { status: "draft", published: false })
  v.unpublished = await variant("fixture-unpublished", { published: false })
  v.archivedSize = await variant("fixture-archived-size")
  await ctx.db.productVariant.update({ where: { id: v.archivedSize.id }, data: { archivedAt: new Date() } })
})
after(() => ctx?.teardown())

describe("CHV-S11-M04 add cart item", () => {
  test("a price, total, currency, title or cart id sent by the browser is ignored", async () => {
    const jar = new Jar()
    const forged = {
      variantId: v.gown.id,
      quantity: 2,
      price: 1,
      unitPrice: { amountPaise: 1, currency: "USD" },
      pricePaise: 1,
      amountPaise: 1,
      compareAtPrice: { amountPaise: 1 },
      subtotal: { amountPaise: 2 },
      currency: "USD",
      title: "Free gown",
      handle: "free-gown",
      cartId: randomUUID(),
      lines: [{ variantId: v.gown.id, quantity: 9, price: 1 }],
    }
    const res = await post(jar, forged)
    assert.equal(res.status, 200, JSON.stringify(res.json))
    const [line] = res.json.data.lines
    assert.deepEqual(line.unitPrice, { amountPaise: v.gown.pricePaise, currency: "INR" })
    assert.equal(line.quantity, 2, "only the top-level quantity counts")
    assert.equal(line.title, v.gown.title)
    assert.equal(line.handle, "fixture-gown")
    assert.deepEqual(res.json.data.subtotal, { amountPaise: 2 * v.gown.pricePaise, currency: "INR" })
    assert.notEqual(res.json.data.id, forged.cartId)
    // The stored line holds no price at all: only which variant and how many.
    const stored = await ctx.db.cartLine.findUniqueOrThrow({ where: { id: line.id } })
    assert.deepEqual(Object.keys(stored).sort(), ["cartId", "createdAt", "id", "quantity", "variantId"])
  })

  test("the bag shows the catalogue's current price, not the price when it was added", async () => {
    const item = await variant("fixture-repriced", { pricePaise: 200000n })
    const jar = new Jar()
    await add(jar, item.id)
    await ctx.db.productVariant.update({ where: { id: item.id }, data: { pricePaise: 250000n } })
    const now = await bag(jar)
    assert.equal(now.lines[0].unitPrice.amountPaise, 250000)
    assert.equal(now.subtotal.amountPaise, 250000)
  })

  test("the variant ID and quantity are validated, and a refused add starts no guest session", async () => {
    const sessions = await ctx.db.guestSession.count()
    const cases = [
      [{}, 400],
      [{ variantId: 42 }, 400],
      [{ variantId: [v.gown.id] }, 400],
      [{ variantId: { id: v.gown.id } }, 400],
      [{ variantId: `${v.gown.id} ` }, 400],
      [{ variantId: v.gown.id, quantity: 0 }, 400],
      [{ variantId: v.gown.id, quantity: -1 }, 400],
      [{ variantId: v.gown.id, quantity: 11 }, 400],
      [{ variantId: v.gown.id, quantity: 2.5 }, 400],
      [{ variantId: v.gown.id, quantity: "1" }, 400],
      [{ variantId: v.gown.id, quantity: null }, 400],
      [{ variantId: v.gown.id, quantity: 1e309 }, 400],
    ]
    for (const [body, status] of cases) {
      const res = await post(new Jar(), body)
      assert.equal(res.status, status, JSON.stringify(body))
      assert.equal(guestCookie(res.response), undefined)
    }
    const huge = await post(new Jar(), { variantId: v.gown.id, filler: "x".repeat(70 * 1024) })
    assert.equal(huge.status, 413)
    assert.equal(await ctx.db.guestSession.count(), sessions)
    const defaulted = await post(new Jar(), { variantId: v.gown.id })
    assert.equal(defaulted.json.data.lines[0].quantity, 1, "quantity defaults to one")
  })

  test("only variants on sale now can be added: drafts, unpublished, uncounted and withdrawn sizes read as missing", async () => {
    for (const item of [v.draft, v.unpublished, v.uncounted, v.archivedSize]) {
      const res = await add(new Jar(), item.id)
      assert.equal(res.status, 404, item.title)
      assert.equal(res.json.error.code, "not_found")
    }
    await ctx.db.product.update({ where: { id: v.gown.productId }, data: { status: "archived" } })
    assert.equal((await add(new Jar(), v.gown.id)).status, 404, "taken down a moment ago")
    await ctx.db.product.update({ where: { id: v.gown.productId }, data: { status: "active" } })
  })

  test("availability is read on the server at the moment of the add, after stock held for orders", async () => {
    // fixture-few: 3 on hand, 1 held for an order, so 2 are free.
    const jar = new Jar()
    assert.equal((await add(jar, v.few.id, 2)).status, 200)
    const over = await add(jar, v.few.id, 1)
    assert.equal(over.status, 409)
    assert.deepEqual(over.json.error.fields, { quantity: "exceeds_stock" })
    assert.equal((await bag(jar)).lines[0].quantity, 2, "the bag keeps what fits")
    assert.equal((await add(new Jar(), v.few.id, 3)).status, 409, "more than is free in one go")
    // Stock taken by another order in the meantime is respected on the next add.
    await ctx.db.inventoryBalance.update({ where: { variantId: v.few.id }, data: { reserved: 3 } })
    const gone = await add(new Jar(), v.few.id)
    assert.equal(gone.status, 409)
    assert.equal(gone.json.error.fields.variantId, "sold_out")
    await ctx.db.inventoryBalance.update({ where: { variantId: v.few.id }, data: { reserved: 1 } })
  })

  test("an add needs an Idempotency-Key; a missing or malformed one changes nothing", async () => {
    const sessions = await ctx.db.guestSession.count()
    const missing = await add(new Jar(), v.gown.id, 1, null)
    assert.equal(missing.status, 428)
    for (const key of ["short", "has space in it", "x".repeat(101), "semi;colon-key"]) assert.equal((await add(new Jar(), v.gown.id, 1, key)).status, 400, key)
    assert.equal(await ctx.db.guestSession.count(), sessions, "no session started")
  })

  test("a retried add with the same key counts once and returns the same bag", async () => {
    const jar = new Jar()
    const key = randomUUID()
    const first = await add(jar, v.gown.id, 2, key)
    const again = await add(jar, v.gown.id, 2, key)
    assert.equal(again.status, 200)
    assert.deepEqual(again.json.data, first.json.data, "identical bag, same revision")
    assert.equal((await bag(jar)).lines[0].quantity, 2)
    const changed = await add(jar, v.gown.id, 3, key)
    assert.equal(changed.status, 409, "the same key for a different add is refused")
    assert.equal((await bag(jar)).lines[0].quantity, 2)
    assert.equal((await add(jar, v.gown.id, 1)).json.data.lines[0].quantity, 3, "a new key adds again")
  })

  test("the same key sent several times at once is applied exactly once", async () => {
    const jar = new Jar()
    await add(jar, v.gown.id)
    const before = await bag(jar)
    const key = randomUUID()
    const results = await Promise.all(Array.from({ length: 5 }, () => add(jar, v.gown.id, 2, key)))
    for (const r of results) assert.equal(r.status, 200, JSON.stringify(r.json))
    const after = await bag(jar)
    assert.equal(after.lines[0].quantity, 3)
    assert.equal(after.revision, before.revision + 1)
  })

  test("a key belongs to its own bag: another shopper using the same key value is unaffected", async () => {
    const key = randomUUID()
    const a = new Jar()
    const b = new Jar()
    await add(a, v.gown.id, 1, key)
    const theirs = await add(b, v.gown.id, 4, key)
    assert.equal(theirs.status, 200)
    assert.equal(theirs.json.data.lines[0].quantity, 4)
    assert.equal((await bag(a)).lines[0].quantity, 1)
  })

  test("racing adds never put more in one bag than the shop has free", async () => {
    const jar = new Jar()
    await add(jar, v.gown.id)
    const results = await Promise.all(Array.from({ length: 5 }, () => add(jar, v.race.id)))
    assert.deepEqual(results.map(r => r.status).sort(), [200, 200, 200, 409, 409])
    assert.equal((await bag(jar)).lines.find(l => l.variantId === v.race.id).quantity, 3)
  })
})
