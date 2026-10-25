// CHV-S11-M02: a guest's bag is kept on the server, survives a reload, and never reveals who the
// shopper is. Runs the real API in-process behind the web host's forwarder (lib/api/forward.ts),
// against a throwaway database, exactly as a browser on the shop would call /api/cart.
import { after, before, describe, test } from "node:test"
import assert from "node:assert/strict"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { call, Jar, newIp, setup, signInCustomer } from "../auth/helpers.mjs"

let ctx, forward
const products = {}

/** A product the shop is selling: live, published, every size counted, with stock. */
async function product(handle, { status = "active", pricePaise = 249900n, onHand = 5 } = {}) {
  const created = await ctx.db.product.create({
    data: {
      handle,
      title: `Fixture ${handle}`,
      status,
      publishedAt: status === "active" ? new Date() : null,
      variants: { create: [{ sku: `${handle}-m`, title: "M", optionKey: "size:m", selectedOptions: [{ name: "Size", value: "M" }], pricePaise }] },
    },
    include: { variants: true },
  })
  const variant = created.variants[0]
  await ctx.db.inventoryBalance.create({ data: { variantId: variant.id, onHand, lastCountedAt: new Date() } })
  return { id: created.id, variantId: variant.id, pricePaise: Number(pricePaise) }
}

// Every add carries a fresh Idempotency-Key (required since 11.04), as the storefront sends one per press.
const cart = (method, path, { jar, body, headers = {}, ip = newIp() } = {}) =>
  call(forward, `/api/cart${path}`, { method, jar, body, headers: method === "POST" ? { "idempotency-key": randomUUID(), ...headers } : headers, ip })
const add = (jar, variantId, extra = {}) => cart("POST", "/lines", { jar, body: { variantId, quantity: 1, ...extra } })
const guestCookie = response => response.headers.getSetCookie().find(c => c.startsWith("chaanavya_guest="))

before(async () => {
  ctx = await setup("chaanavya_test_s11_guest_cart")
  forward = ctx.routes.me.GET
  products.kurta = await product("fixture-kurta", { onHand: 50 })
  products.saree = await product("fixture-saree", { pricePaise: 520000n })
  products.draft = await product("fixture-draft", { status: "draft" })
  products.soldOut = await product("fixture-sold-out", { onHand: 0 })
})
after(() => ctx?.teardown())

describe("CHV-S11-M02 guest cart persistence", () => {
  test("browsing never starts a guest session: an empty bag is null and sets no cookie", async () => {
    const before = await ctx.db.guestSession.count()
    const res = await cart("GET", "", { jar: new Jar() })
    assert.equal(res.status, 200)
    assert.equal(res.json.data, null)
    assert.equal(guestCookie(res.response), undefined)
    assert.equal(res.response.headers.get("cache-control"), "no-store")
    assert.equal(await ctx.db.guestSession.count(), before)
  })

  test("the first add starts a guest session with a secure, unguessable cookie", async () => {
    const jar = new Jar()
    const res = await add(jar, products.kurta.variantId)
    assert.equal(res.status, 200, JSON.stringify(res.json))
    const cookie = guestCookie(res.response)
    assert.ok(cookie, "a guest cookie is set")
    const token = cookie.split(";")[0].split("=")[1]
    assert.match(token, /^[A-Za-z0-9_-]{43}$/, "32 random bytes")
    for (const attr of ["HttpOnly", "SameSite=Lax", "Path=/"]) assert.ok(cookie.includes(attr), `${attr} in ${cookie.replace(token, "<token>")}`)
    assert.ok(!/;\s*Domain=/i.test(cookie), "host-only")
    assert.ok(!cookie.includes("Secure"), "no Secure flag on plain http (local development)")
    // Only the hash is stored, and the cart belongs to that session.
    const session = await ctx.db.guestSession.findUnique({ where: { tokenHash: createHash("sha256").update(token).digest("hex") } })
    assert.ok(session, "stored by hash")
    assert.equal(await ctx.db.guestSession.count({ where: { tokenHash: token } }), 0, "the token itself is never stored")
    const stored = await ctx.db.cart.findUniqueOrThrow({ where: { id: res.json.data.id } })
    assert.equal(stored.guestSessionId, session.id)
    assert.equal(stored.userId, null)
  })

  test("over https the guest cookie is Secure", async () => {
    const res = await cart("POST", "/lines", { jar: new Jar(), body: { variantId: products.kurta.variantId }, headers: { "x-forwarded-proto": "https" } })
    assert.equal(res.status, 200)
    assert.ok(guestCookie(res.response).includes("; Secure"))
  })

  test("the bag survives a reload: the same cookie reads back the same cart and lines", async () => {
    const jar = new Jar()
    const first = await add(jar, products.kurta.variantId)
    await add(jar, products.saree.variantId, { quantity: 2 })
    // A reload is a fresh request carrying only the cookie.
    const reloaded = await cart("GET", "", { jar })
    assert.equal(reloaded.status, 200)
    assert.equal(reloaded.json.data.id, first.json.data.id)
    assert.deepEqual(reloaded.json.data.lines.map(l => [l.handle, l.variantTitle, l.quantity]), [["fixture-kurta", "M", 1], ["fixture-saree", "M", 2]])
    assert.equal(reloaded.json.data.subtotal.amountPaise, products.kurta.pricePaise + 2 * products.saree.pricePaise)
    assert.equal(reloaded.json.data.revision, 2)
    assert.equal(guestCookie(reloaded.response), undefined, "a read does not reissue the cookie")
  })

  test("nothing in a cart response names the shopper", async () => {
    const jar = new Jar()
    const res = await add(jar, products.kurta.variantId)
    const token = jar.cookies.get("chaanavya_guest")
    const { guestSessionId } = await ctx.db.cart.findUniqueOrThrow({ where: { id: res.json.data.id } })
    const session = await ctx.db.guestSession.findUniqueOrThrow({ where: { id: guestSessionId } })
    for (const body of [JSON.stringify(res.json), JSON.stringify((await cart("GET", "", { jar })).json)]) {
      for (const secret of [token, guestSessionId, session.tokenHash]) assert.ok(!body.includes(secret), "no token, session id or hash")
      for (const key of ["owner", "userId", "guestSessionId", "email", "token"]) assert.ok(!body.includes(`"${key}"`), `no ${key} field`)
    }
    assert.deepEqual(Object.keys(res.json.data).sort(), ["discount", "expiresAt", "id", "issues", "lines", "promotion", "revision", "subtotal", "total", "version"])
  })

  test("another browser sees no bag, and another guest cannot read or change this one", async () => {
    const a = new Jar()
    const b = new Jar()
    const mine = (await add(a, products.kurta.variantId)).json.data
    await add(b, products.saree.variantId)
    assert.equal((await cart("GET", "", { jar: new Jar() })).json.data, null, "a new browser starts empty")
    const theirs = (await cart("GET", "", { jar: b })).json.data
    assert.notEqual(theirs.id, mine.id)
    assert.deepEqual(theirs.lines.map(l => l.handle), ["fixture-saree"])
    // B holding A's line id gets the same 404 as a made-up line.
    for (const lineId of [mine.lines[0].id, randomUUID(), "not-a-uuid"]) {
      const res = await cart("PATCH", `/lines/${lineId}`, { jar: b, body: { quantity: 5 } })
      assert.equal(res.status, 404, lineId)
      assert.equal(res.json.error.code, "not_found")
    }
    assert.equal((await cart("PATCH", `/lines/${mine.lines[0].id}`, { jar: new Jar(), body: { quantity: 5 } })).status, 404, "no cookie, no cart")
    assert.equal((await cart("GET", "", { jar: a })).json.data.lines[0].quantity, 1, "A untouched")
  })

  test("a made-up, revoked or expired guest cookie reads no bag and is cleared", async () => {
    const forged = new Jar({ chaanavya_guest: randomBytes(32).toString("base64url") })
    const res = await cart("GET", "", { jar: forged })
    assert.equal(res.json.data, null)
    assert.match(guestCookie(res.response), /Max-Age=0/)
    assert.equal(forged.has("chaanavya_guest"), false)

    const jar = new Jar()
    const { id } = (await add(jar, products.kurta.variantId)).json.data
    const { guestSessionId } = await ctx.db.cart.findUniqueOrThrow({ where: { id } })
    await ctx.guest.revokeGuestSession(ctx.db, guestSessionId)
    assert.equal((await cart("GET", "", { jar })).json.data, null, "revoked")

    const old = new Jar()
    const cartId = (await add(old, products.kurta.variantId)).json.data.id
    const owner = await ctx.db.cart.findUniqueOrThrow({ where: { id: cartId } })
    await ctx.db.guestSession.update({ where: { id: owner.guestSessionId }, data: { expiresAt: new Date(Date.now() - 1000) } })
    assert.equal((await cart("GET", "", { jar: old })).json.data, null, "expired")
    // Adding again starts a new session and a new, empty cart; the old one is not reopened.
    const fresh = await add(old, products.saree.variantId)
    assert.notEqual(fresh.json.data.id, cartId)
    assert.deepEqual(fresh.json.data.lines.map(l => l.handle), ["fixture-saree"])
  })

  test("prices come from the catalogue: a price sent by the browser is ignored", async () => {
    const res = await add(new Jar(), products.saree.variantId, { price: 1, unitPrice: { amountPaise: 1 }, pricePaise: 1, quantity: 2 })
    assert.equal(res.status, 200)
    assert.equal(res.json.data.lines[0].unitPrice.amountPaise, products.saree.pricePaise)
    assert.equal(res.json.data.subtotal.amountPaise, 2 * products.saree.pricePaise)
  })

  test("only what the shop is selling can be added, in sensible quantities, and a refusal starts no session", async () => {
    const sessions = await ctx.db.guestSession.count()
    const cases = [
      [{ variantId: "nope" }, 400],
      [{ variantId: randomUUID() }, 404],
      [{ variantId: products.draft.variantId }, 404],
      [{ variantId: products.soldOut.variantId }, 409],
      [{ variantId: products.kurta.variantId, quantity: 0 }, 400],
      [{ variantId: products.kurta.variantId, quantity: 11 }, 400],
      [{ variantId: products.kurta.variantId, quantity: 1.5 }, 400],
      [{ variantId: products.kurta.variantId, quantity: "2" }, 400],
    ]
    for (const [body, status] of cases) {
      const res = await cart("POST", "/lines", { jar: new Jar(), body })
      assert.equal(res.status, status, JSON.stringify(body))
      assert.equal(guestCookie(res.response), undefined, `no cookie for ${JSON.stringify(body)}`)
    }
    assert.equal(await ctx.db.guestSession.count(), sessions, "no session rows from refused adds")
    assert.equal(await ctx.db.cartLine.count({ where: { variantId: { in: [products.draft.variantId, products.soldOut.variantId] } } }), 0)
  })

  test("a cross-site request cannot add to a shopper's bag", async () => {
    const jar = new Jar()
    await add(jar, products.kurta.variantId)
    const res = await call(forward, "/api/cart/lines", { method: "POST", jar, body: { variantId: products.saree.variantId }, origin: "https://evil.example", headers: { "sec-fetch-site": "cross-site" }, ip: newIp() })
    assert.ok(res.status >= 400 && res.status < 500, `refused with ${res.status}`)
    assert.deepEqual((await cart("GET", "", { jar })).json.data.lines.map(l => l.handle), ["fixture-kurta"])
  })

  test("quantities change, cap at the limit, and 0 removes; a replayed change is harmless", async () => {
    const jar = new Jar()
    const line = (await add(jar, products.kurta.variantId)).json.data.lines[0]
    for (let i = 0; i < 2; i++) {
      const res = await cart("PATCH", `/lines/${line.id}`, { jar, body: { quantity: 3 } })
      assert.equal(res.status, 200)
      assert.equal(res.json.data.lines[0].quantity, 3, "setting a quantity twice gives the same bag")
    }
    const capped = await add(jar, products.kurta.variantId, { quantity: 10 })
    assert.equal(capped.json.data.lines[0].quantity, 10)
    assert.equal((await cart("PATCH", `/lines/${line.id}`, { jar, body: { quantity: 0 } })).json.data.lines.length, 0)
    const replay = await cart("PATCH", `/lines/${line.id}`, { jar, body: { quantity: 2 } })
    assert.equal(replay.status, 404, "a removed line stays removed")
  })

  test("concurrent adds to one bag all land, one after another", async () => {
    const jar = new Jar()
    const start = (await add(jar, products.saree.variantId)).json.data
    const results = await Promise.all(Array.from({ length: 6 }, () => add(jar, products.kurta.variantId)))
    for (const r of results) assert.equal(r.status, 200, JSON.stringify(r.json))
    const final = (await cart("GET", "", { jar })).json.data
    assert.equal(final.id, start.id, "no second cart")
    assert.equal(final.lines.find(l => l.handle === "fixture-kurta").quantity, 6)
    assert.equal(final.revision, start.revision + 6, "every change bumped the revision once")
  })

  test("a product taken down after it was added stays in the bag, flagged and not charged", async () => {
    const extra = await product("fixture-withdrawn")
    const jar = new Jar()
    await add(jar, products.kurta.variantId)
    await add(jar, extra.variantId)
    await ctx.db.product.update({ where: { id: extra.id }, data: { status: "archived" } })
    const bag = (await cart("GET", "", { jar })).json.data
    const withdrawn = bag.lines.find(l => l.handle === "fixture-withdrawn")
    assert.deepEqual(bag.issues, [{ kind: "unavailable", lineId: withdrawn.id }])
    assert.equal(bag.subtotal.amountPaise, products.kurta.pricePaise)
  })

  test("a signed-in customer's bag is theirs, with no guest cookie", async () => {
    const jar = await signInCustomer(ctx, "bag.customer@example.com")
    const res = await add(jar, products.kurta.variantId)
    assert.equal(res.status, 200)
    assert.equal(guestCookie(res.response), undefined)
    const user = await ctx.db.user.findUniqueOrThrow({ where: { email: "bag.customer@example.com" } })
    const stored = await ctx.db.cart.findUniqueOrThrow({ where: { id: res.json.data.id } })
    assert.equal(stored.userId, user.id)
    assert.equal(stored.guestSessionId, null)
    assert.ok(!JSON.stringify(res.json).includes(user.id) && !JSON.stringify(res.json).includes("bag.customer"), "names nobody")
  })
})
