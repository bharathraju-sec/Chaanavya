// CHV-S11-M01: one cart never becomes accessible to a different guest. Cart ownership and expiry
// rules live in apps/api/src/cart/ownership.ts; this runs them against a real throwaway database.
import { after, before, describe, test } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { apiModule, Jar, setup, signInCustomer } from "../auth/helpers.mjs"

let ctx, cart, session
const guests = {}
let customer

const DAY = 86_400_000

before(async () => {
  ctx = await setup("chaanavya_test_s11_cart_ownership")
  cart = await apiModule("cart/ownership")
  session = await apiModule("auth/session")
  for (const name of ["a", "b"]) {
    const { session: s, token } = await ctx.guest.createGuestSession(ctx.db)
    guests[name] = { owner: { kind: "guest", guestSessionId: s.id }, session: s, token }
    guests[name].cart = await cart.openCart(ctx.db, guests[name].owner)
  }
  await signInCustomer(ctx, "cart.customer@example.com")
  const user = await ctx.db.user.findUniqueOrThrow({ where: { email: "cart.customer@example.com" } })
  customer = { owner: { kind: "customer", customerId: user.id } }
  customer.cart = await cart.openCart(ctx.db, customer.owner)
})
after(() => ctx?.teardown())

const find = (who, id) => cart.findOwnedCart(ctx.db, who.owner, id)

describe("CHV-S11-M01 cart ownership", () => {
  test("each guest opens their own cart, and opening again returns the same one", async () => {
    assert.notEqual(guests.a.cart.id, guests.b.cart.id)
    assert.equal(guests.a.cart.guestSessionId, guests.a.session.id)
    assert.equal(guests.a.cart.userId, null)
    assert.equal((await cart.openCart(ctx.db, guests.a.owner)).id, guests.a.cart.id)
    assert.equal((await find(guests.a, guests.a.cart.id))?.id, guests.a.cart.id)
  })

  test("another guest holding the cart id gets nothing, the same as a cart that does not exist", async () => {
    assert.equal(await find(guests.b, guests.a.cart.id), null)
    assert.equal(await find(guests.a, guests.b.cart.id), null)
    assert.equal(await find(guests.b, randomUUID()), null)
    assert.equal((await cart.openCart(ctx.db, guests.b.owner)).id, guests.b.cart.id, "opening never hands B the cart of A")
  })

  test("another guest cannot change the cart, even with its exact revision", async () => {
    assert.equal(await cart.renewCart(ctx.db, guests.b.owner, guests.a.cart.id, guests.a.cart.revision), false)
    const stored = await ctx.db.cart.findUniqueOrThrow({ where: { id: guests.a.cart.id } })
    assert.equal(stored.revision, guests.a.cart.revision, "untouched")
  })

  test("guests and customers never reach each other's carts", async () => {
    assert.equal(await find(customer, guests.a.cart.id), null)
    assert.equal(await find(guests.a, customer.cart.id), null)
    assert.equal((await find(customer, customer.cart.id))?.id, customer.cart.id)
    assert.equal(customer.cart.guestSessionId, null)
  })

  test("a signed-in shopper shops as the customer even with a guest cookie still present", () => {
    const owner = cart.cartOwnerOf({ userId: customer.owner.customerId, emailVerified: true, guestSessionId: guests.a.session.id })
    assert.deepEqual(owner, customer.owner)
    assert.deepEqual(cart.cartOwnerOf({ userId: null, emailVerified: false, guestSessionId: guests.a.session.id }), guests.a.owner)
    assert.equal(cart.cartOwnerOf({ userId: null, emailVerified: false, guestSessionId: null }), null, "no session, no cart")
  })

  test("malformed and made-up cart ids read nothing and never reach the database as a query error", async () => {
    for (const id of ["", "not-a-uuid", `${guests.a.cart.id}'--`, guests.a.cart.id.toUpperCase().replace(/./, "x")]) {
      assert.equal(await find(guests.a, id), null, JSON.stringify(id))
    }
  })

  test("a revoked guest session loses its cart, and a fresh session for the same browser starts empty", async () => {
    const { session: s } = await ctx.guest.createGuestSession(ctx.db)
    const owner = { kind: "guest", guestSessionId: s.id }
    const own = await cart.openCart(ctx.db, owner)
    assert.equal((await cart.findOwnedCart(ctx.db, owner, own.id))?.id, own.id)
    await ctx.guest.revokeGuestSession(ctx.db, s.id)
    assert.equal(await cart.findOwnedCart(ctx.db, owner, own.id), null)
    assert.equal(await cart.openCart(ctx.db, owner), null, "a revoked session cannot open a new cart")
    assert.equal(await cart.renewCart(ctx.db, owner, own.id, own.revision), false)
    const next = await ctx.guest.createGuestSession(ctx.db)
    const fresh = await cart.openCart(ctx.db, { kind: "guest", guestSessionId: next.session.id })
    assert.notEqual(fresh.id, own.id)
  })

  test("an expired guest session loses its cart even while the cart row is unexpired", async () => {
    const { session: s } = await ctx.guest.createGuestSession(ctx.db)
    const owner = { kind: "guest", guestSessionId: s.id }
    const own = await cart.openCart(ctx.db, owner)
    await ctx.db.guestSession.update({ where: { id: s.id }, data: { expiresAt: new Date(Date.now() - 1000) } })
    await ctx.db.cart.update({ where: { id: own.id }, data: { expiresAt: new Date(Date.now() + DAY) } })
    assert.equal(await cart.findOwnedCart(ctx.db, owner, own.id), null)
  })

  test("an expired cart reads as missing to its own guest, and opening starts a new one", async () => {
    const { session: s } = await ctx.guest.createGuestSession(ctx.db)
    const owner = { kind: "guest", guestSessionId: s.id }
    const own = await cart.openCart(ctx.db, owner)
    await ctx.db.cart.update({ where: { id: own.id }, data: { expiresAt: new Date(Date.now() - 1000) } })
    assert.equal(await cart.findOwnedCart(ctx.db, owner, own.id), null)
    assert.notEqual((await cart.openCart(ctx.db, owner)).id, own.id)
  })

  test("a guest cart never outlives its guest session; a change renews the expiry", async () => {
    const now = new Date()
    assert.equal(cart.cartExpiry(now).getTime(), now.getTime() + cart.CART_LIFETIME.idleDays * DAY)
    const soon = new Date(now.getTime() + 2 * DAY)
    assert.equal(cart.cartExpiry(now, soon).getTime(), soon.getTime())
    const opened = await ctx.db.cart.findUniqueOrThrow({ where: { id: guests.a.cart.id } })
    assert.ok(opened.expiresAt <= guests.a.session.expiresAt)
    const shortSession = await ctx.guest.createGuestSession(ctx.db)
    await ctx.db.guestSession.update({ where: { id: shortSession.session.id }, data: { expiresAt: soon } })
    const capped = await cart.openCart(ctx.db, { kind: "guest", guestSessionId: shortSession.session.id })
    assert.equal(capped.expiresAt.getTime(), soon.getTime())
    const later = new Date(now.getTime() + DAY)
    assert.equal(await cart.renewCart(ctx.db, guests.a.owner, guests.a.cart.id, opened.revision, later), true)
    const renewed = await ctx.db.cart.findUniqueOrThrow({ where: { id: guests.a.cart.id } })
    assert.equal(renewed.revision, opened.revision + 1)
    assert.ok(renewed.expiresAt > opened.expiresAt || renewed.expiresAt.getTime() === guests.a.session.expiresAt.getTime())
    assert.ok(renewed.expiresAt <= guests.a.session.expiresAt)
  })

  test("two writers on the same revision: exactly one wins (replayed change is refused)", async () => {
    const current = await ctx.db.cart.findUniqueOrThrow({ where: { id: guests.b.cart.id } })
    const results = await Promise.all([1, 2, 3].map(() => cart.renewCart(ctx.db, guests.b.owner, current.id, current.revision)))
    assert.equal(results.filter(Boolean).length, 1)
    assert.equal(await cart.renewCart(ctx.db, guests.b.owner, current.id, current.revision), false, "a replay of the old revision")
  })

  test("racing guests opening carts at once each get only their own", async () => {
    const fresh = await Promise.all([1, 2, 3, 4].map(() => ctx.guest.createGuestSession(ctx.db)))
    const owners = fresh.map(f => ({ kind: "guest", guestSessionId: f.session.id }))
    const carts = await Promise.all(owners.flatMap(o => [cart.openCart(ctx.db, o), cart.openCart(ctx.db, o)]))
    carts.forEach((c, i) => assert.equal(c.guestSessionId, owners[Math.floor(i / 2)].guestSessionId))
    for (const [i, c] of carts.entries()) {
      for (const [j, o] of owners.entries()) {
        if (j !== Math.floor(i / 2)) assert.equal(await cart.findOwnedCart(ctx.db, o, c.id), null)
      }
    }
  })

  test("abandoned is a reporting state only and grants nothing", () => {
    const now = new Date()
    const live = { expiresAt: new Date(now.getTime() + DAY), lineCount: 2 }
    assert.equal(cart.cartState({ ...live, updatedAt: now }, now), "active")
    assert.equal(cart.cartState({ ...live, updatedAt: new Date(now.getTime() - 25 * 3600_000) }, now), "abandoned")
    assert.equal(cart.cartState({ ...live, lineCount: 0, updatedAt: new Date(now.getTime() - 25 * 3600_000) }, now), "active", "an empty cart is not abandoned")
    assert.equal(cart.cartState({ ...live, expiresAt: now, updatedAt: now }, now), "expired")
  })

  test("the database refuses a cart with two owners or none", async () => {
    await assert.rejects(ctx.db.cart.create({ data: { userId: customer.owner.customerId, guestSessionId: guests.a.session.id, expiresAt: new Date(Date.now() + DAY) } }), /cart_single_owner|check constraint/i)
    await assert.rejects(ctx.db.cart.create({ data: { expiresAt: new Date(Date.now() + DAY) } }), /cart_single_owner|check constraint/i)
  })

  test("the shared ownership rule agrees: a guest record never matches another guest", () => {
    assert.equal(session.ownsRecord({ userId: null, guestSessionId: guests.b.session.id }, guests.a.cart), false)
    assert.equal(session.ownsRecord({ userId: null, guestSessionId: guests.a.session.id }, guests.a.cart), true)
  })

  test("the guest cookie still resolves to its own session only", async () => {
    const jar = new Jar({ [ctx.guest.GUEST_COOKIE]: guests.a.token })
    const found = await ctx.guest.findGuestSession(ctx.db, new Headers({ cookie: jar.header() }))
    assert.equal(found?.id, guests.a.session.id)
  })
})
