// CHV-S11-M03: a signed-in customer's bag belongs to their verified account, follows them to every
// session, and no other account (or guest) can read or change it by guessing its id. Runs the real
// API in-process behind the web host's forwarder, against a throwaway database.
import { after, before, describe, test } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { apiModule, call, Jar, newIp, setup, signInCustomer } from "../auth/helpers.mjs"

let ctx, forward, ownership
const products = {}
const people = {}

async function product(handle, pricePaise = 189900n) {
  const created = await ctx.db.product.create({
    data: { handle, title: `Fixture ${handle}`, status: "active", publishedAt: new Date(), variants: { create: [{ sku: `${handle}-m`, title: "M", optionKey: "size:m", pricePaise }] } },
    include: { variants: true },
  })
  await ctx.db.inventoryBalance.create({ data: { variantId: created.variants[0].id, onHand: 20, lastCountedAt: new Date() } })
  return { variantId: created.variants[0].id, pricePaise: Number(pricePaise) }
}

// Every add carries a fresh Idempotency-Key (required since 11.04).
const cart = (method, path, { jar, body } = {}) => call(forward, `/api/cart${path}`, { method, jar, body, headers: method === "POST" ? { "idempotency-key": randomUUID() } : {}, ip: newIp() })
const add = (jar, variantId, quantity = 1) => cart("POST", "/lines", { jar, body: { variantId, quantity } })
const guestCookie = response => response.headers.getSetCookie().find(c => c.startsWith("chaanavya_guest="))
const userOf = email => ctx.db.user.findUniqueOrThrow({ where: { email } })

before(async () => {
  ctx = await setup("chaanavya_test_s11_customer_cart")
  forward = ctx.routes.me.GET
  ownership = await apiModule("cart/ownership")
  products.dress = await product("fixture-dress")
  products.scarf = await product("fixture-scarf", 99900n)
  for (const [name, email] of [["a", "cart.a@example.com"], ["b", "cart.b@example.com"]]) {
    people[name] = { email, jar: await signInCustomer(ctx, email) }
  }
  people.a.cart = (await add(people.a.jar, products.dress.variantId, 2)).json.data
  people.b.cart = (await add(people.b.jar, products.scarf.variantId)).json.data
})
after(() => ctx?.teardown())

describe("CHV-S11-M03 authenticated cart persistence", () => {
  test("a customer's bag is attached to their account, not to a guest session", async () => {
    const user = await userOf(people.a.email)
    const stored = await ctx.db.cart.findUniqueOrThrow({ where: { id: people.a.cart.id } })
    assert.equal(stored.userId, user.id)
    assert.equal(stored.guestSessionId, null)
    assert.equal(user.emailVerified, true, "email-code sign-in verifies the address")
  })

  test("another account cannot read the bag by its id: the same 404 as a made-up id", async () => {
    const refusals = []
    for (const id of [people.a.cart.id, randomUUID(), people.a.cart.id.replace(/.$/, c => (c === "0" ? "1" : "0")), "not-a-uuid", `${people.a.cart.id}'--`]) {
      const res = await cart("GET", `/${encodeURIComponent(id)}`, { jar: people.b.jar })
      assert.equal(res.status, 404, id)
      refusals.push(JSON.stringify(res.json))
    }
    assert.equal(new Set(refusals).size, 1, "every refusal reads the same, so a real id is never confirmed")
    assert.ok(!refusals[0].includes(people.a.cart.id))
    // The owner can read it by id, and B's own bag is unaffected.
    const own = await cart("GET", `/${people.a.cart.id}`, { jar: people.a.jar })
    assert.equal(own.status, 200)
    assert.equal(own.json.data.lines[0].quantity, 2)
    assert.equal((await cart("GET", "", { jar: people.b.jar })).json.data.id, people.b.cart.id)
  })

  test("a guest or anonymous visitor holding the id gets the same 404", async () => {
    const guest = new Jar()
    await add(guest, products.scarf.variantId)
    for (const jar of [guest, new Jar()]) assert.equal((await cart("GET", `/${people.a.cart.id}`, { jar })).status, 404)
  })

  test("another account cannot change the bag's lines, even with the exact line id", async () => {
    const lineId = people.a.cart.lines[0].id
    for (const quantity of [0, 5]) {
      const res = await cart("PATCH", `/lines/${lineId}`, { jar: people.b.jar, body: { quantity } })
      assert.equal(res.status, 404)
    }
    const stored = await ctx.db.cartLine.findUniqueOrThrow({ where: { id: lineId } })
    assert.equal(stored.quantity, 2, "untouched")
    assert.equal((await ctx.db.cart.findUniqueOrThrow({ where: { id: people.a.cart.id } })).revision, people.a.cart.revision, "revision untouched")
  })

  test("the bag follows the account: a new sign-in on another device sees the same bag", async () => {
    const phone = await signInCustomer(ctx, people.a.email)
    const res = await cart("GET", "", { jar: phone })
    assert.equal(res.json.data.id, people.a.cart.id)
    assert.equal(res.json.data.lines[0].quantity, 2)
    assert.equal(guestCookie(res.response), undefined)
  })

  test("two devices of one customer changing the bag at once both land in the one bag", async () => {
    const tablet = await signInCustomer(ctx, people.a.email)
    const results = await Promise.all([add(people.a.jar, products.scarf.variantId), add(tablet, products.scarf.variantId), add(tablet, products.scarf.variantId)])
    for (const r of results) assert.equal(r.status, 200, JSON.stringify(r.json))
    const bag = (await cart("GET", "", { jar: people.a.jar })).json.data
    assert.equal(bag.id, people.a.cart.id)
    assert.equal(bag.lines.find(l => l.variantId === products.scarf.variantId).quantity, 3)
    const user = await userOf(people.a.email)
    assert.equal(await ctx.db.cart.count({ where: { userId: user.id } }), 1, "still one cart for the account")
  })

  test("an account whose email is not verified does not own a bag: it shops as a guest", async () => {
    const email = "cart.unverified@example.com"
    const jar = await signInCustomer(ctx, email)
    const user = await userOf(email)
    await ctx.db.user.update({ where: { id: user.id }, data: { emailVerified: false } })
    const res = await add(jar, products.dress.variantId)
    assert.equal(res.status, 200)
    assert.ok(guestCookie(res.response), "a guest session was started instead")
    const stored = await ctx.db.cart.findUniqueOrThrow({ where: { id: res.json.data.id } })
    assert.equal(stored.userId, null, "not attached to the unverified account")
    assert.ok(stored.guestSessionId)
    assert.equal(await ctx.db.cart.count({ where: { userId: user.id } }), 0)
  })

  test("a customer bag becomes unreachable once the account is unverified or disabled, even by its id", async () => {
    const email = "cart.c@example.com"
    const jar = await signInCustomer(ctx, email)
    const own = (await add(jar, products.dress.variantId)).json.data
    const user = await userOf(email)
    const owner = { kind: "customer", customerId: user.id }

    await ctx.db.user.update({ where: { id: user.id }, data: { emailVerified: false } })
    assert.equal((await cart("GET", `/${own.id}`, { jar })).status, 404)
    // The database filter refuses it too, so no caller can reach it by building the owner by hand.
    assert.equal(await ownership.findOwnedCart(ctx.db, owner, own.id), null)
    assert.equal(await ownership.renewCart(ctx.db, owner, own.id, own.revision), false)

    await ctx.db.user.update({ where: { id: user.id }, data: { emailVerified: true, disabledAt: new Date() } })
    assert.equal((await cart("GET", `/${own.id}`, { jar })).status, 404, "disabled")
    assert.equal(await ownership.findOwnedCart(ctx.db, owner, own.id), null)

    await ctx.db.user.update({ where: { id: user.id }, data: { disabledAt: null } })
    assert.equal((await cart("GET", `/${own.id}`, { jar })).json.data.id, own.id, "back once the account is enabled again")
  })

  test("a customer never takes over the guest bag itself: since 11.08 its items are copied into the account's own bag", async () => {
    const jar = new Jar()
    const guestBag = (await add(jar, products.dress.variantId)).json.data
    await signInCustomer(ctx, "cart.d@example.com", { jar })
    assert.equal(jar.has("chaanavya_guest"), false, "the guest cookie is retired at sign-in")
    assert.equal((await cart("GET", `/${guestBag.id}`, { jar })).status, 404, "the customer is not the guest")
    const own = (await cart("GET", "", { jar })).json.data
    assert.notEqual(own.id, guestBag.id, "a separate account bag")
    assert.deepEqual(own.lines.map(l => l.variantId), [products.dress.variantId])
    assert.equal((await ctx.db.cart.findUniqueOrThrow({ where: { id: guestBag.id } })).userId, null, "the guest cart keeps its guest owner")
  })
})
