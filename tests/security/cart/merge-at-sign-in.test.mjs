// CHV-S11-M08: the guest bag is merged into the account at sign-in, in one transaction, exactly once.
// Repeating the merge (a second sign-in with the same guest cookie, or merges racing each other)
// never counts quantities twice; the guest cookie is retired so the next anonymous visit starts a
// new guest; and a guest bag never passes from one user to another in the same browser. Real API
// in-process behind the forwarder, real email-code sign-in, throwaway database.
import { after, before, describe, test } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { apiModule, authCall, call, Jar, newIp, setup, signInCustomer } from "../auth/helpers.mjs"

let ctx, forward, merge
const v = {}
let emailCounter = 0
const email = () => `merge${++emailCounter}@example.com`

async function variant(handle, pricePaise = 100000n) {
  const created = await ctx.db.product.create({
    data: { handle, title: `Fixture ${handle}`, status: "active", publishedAt: new Date(), variants: { create: [{ sku: `${handle}-m`, title: "M", optionKey: "size:m", pricePaise }] } },
    include: { variants: true },
  })
  await ctx.db.inventoryBalance.create({ data: { variantId: created.variants[0].id, onHand: 500, lastCountedAt: new Date() } })
  return created.variants[0].id
}

const add = (jar, variantId, quantity = 1) => call(forward, "/api/cart/lines", { method: "POST", jar, body: { variantId, quantity }, headers: { "idempotency-key": randomUUID() }, ip: newIp() })
const bag = async jar => (await call(forward, "/api/cart", { jar, ip: newIp() })).json.data
const quantities = b => Object.fromEntries((b?.lines ?? []).map(l => [l.variantId, l.quantity]))
const signOut = jar => authCall(ctx, "/sign-out", { jar, body: {}, ip: newIp() })

/** A browser holding a guest bag; returns the jar, the raw guest token and the guest cart. */
async function guestWith(items) {
  const jar = new Jar()
  let last
  for (const [variantId, quantity] of items) last = await add(jar, variantId, quantity)
  const cart = await ctx.db.cart.findUniqueOrThrow({ where: { id: last.json.data.id } })
  return { jar, token: jar.cookies.get("chaanavya_guest"), cart }
}

before(async () => {
  ctx = await setup("chaanavya_test_s11_merge_at_sign_in")
  forward = ctx.routes.me.GET
  merge = await apiModule("cart/merge-apply")
  for (const name of ["a", "b", "c", "d"]) v[name] = await variant(`fixture-${name}`)
})
after(() => ctx?.teardown())

describe("CHV-S11-M08 transactional cart merge", () => {
  test("signing in merges the guest bag into the account, empties it, ends the guest session and retires the cookie", async () => {
    const guest = await guestWith([[v.a, 2], [v.b, 1]])
    const address = email()
    await signInCustomer(ctx, address, { jar: guest.jar })
    assert.equal(guest.jar.has("chaanavya_guest"), false, "the guest cookie is cleared")
    const account = await bag(guest.jar)
    assert.deepEqual(quantities(account), { [v.a]: 2, [v.b]: 1 })
    const user = await ctx.db.user.findUniqueOrThrow({ where: { email: address } })
    const stored = await ctx.db.cart.findUniqueOrThrow({ where: { id: account.id } })
    assert.equal(stored.userId, user.id)
    assert.equal(stored.guestSessionId, null)
    const guestCart = await ctx.db.cart.findUniqueOrThrow({ where: { id: guest.cart.id } })
    assert.equal(guestCart.userId, null, "the guest cart never becomes the customer's")
    assert.equal(await ctx.db.cartLine.count({ where: { cartId: guest.cart.id } }), 0, "emptied")
    assert.ok((await ctx.db.guestSession.findUniqueOrThrow({ where: { id: guest.cart.guestSessionId } })).revokedAt, "guest session ended")
    const event = await ctx.db.auditEvent.findFirstOrThrow({ where: { action: "cart.merged", actorId: user.id } })
    assert.deepEqual(event.after, { added: 2, raised: 0, leftBehind: 0, promotion: "none" })
    assert.ok(!JSON.stringify(event).includes(guest.token), "the audit holds no guest token")
  })

  test("repeating the merge does not duplicate quantities: a second sign-in with the same guest cookie adds nothing", async () => {
    const guest = await guestWith([[v.a, 3], [v.c, 2]])
    const address = email()
    await signInCustomer(ctx, address, { jar: guest.jar })
    const first = await bag(guest.jar)
    // The same browser cookie presented again (a replayed or copied cookie) on a new sign-in.
    const replay = new Jar({ chaanavya_guest: guest.token })
    await signInCustomer(ctx, address, { jar: replay })
    const second = await bag(replay)
    assert.equal(second.id, first.id)
    assert.deepEqual(quantities(second), quantities(first))
    assert.equal(second.revision, first.revision, "nothing changed")
    assert.equal(replay.has("chaanavya_guest"), false, "the dead cookie is cleared too")
  })

  test("the same guest bag merged many times at once is merged exactly once", async () => {
    const guest = await guestWith([[v.a, 2], [v.d, 1]])
    const address = email()
    await signInCustomer(ctx, address) // creates the account without the guest cookie
    const user = await ctx.db.user.findUniqueOrThrow({ where: { email: address } })
    const outcomes = await Promise.all(Array.from({ length: 6 }, () => merge.mergeGuestCart(ctx.db, { userId: user.id, guestToken: guest.token, correlationId: randomUUID() })))
    assert.deepEqual(outcomes.map(o => o.status).sort(), ["merged", "no_guest", "no_guest", "no_guest", "no_guest", "no_guest"])
    const carts = await ctx.db.cart.findMany({ where: { userId: user.id }, include: { lines: true } })
    assert.equal(carts.length, 1, "one account cart")
    assert.deepEqual(Object.fromEntries(carts[0].lines.map(l => [l.variantId, l.quantity])), { [v.a]: 2, [v.d]: 1 })
    assert.equal(await ctx.db.auditEvent.count({ where: { action: "cart.merged", actorId: user.id } }), 1)
  })

  test("two different guest bags merged into one account at once give one cart with the larger quantities", async () => {
    const one = await guestWith([[v.a, 2], [v.b, 5]])
    const two = await guestWith([[v.a, 4], [v.c, 1]])
    const address = email()
    await signInCustomer(ctx, address)
    const user = await ctx.db.user.findUniqueOrThrow({ where: { email: address } })
    const outcomes = await Promise.all([one, two].map(g => merge.mergeGuestCart(ctx.db, { userId: user.id, guestToken: g.token, correlationId: randomUUID() })))
    assert.deepEqual(outcomes.map(o => o.status), ["merged", "merged"])
    const carts = await ctx.db.cart.findMany({ where: { userId: user.id }, include: { lines: true } })
    assert.equal(carts.length, 1)
    assert.deepEqual(Object.fromEntries(carts[0].lines.map(l => [l.variantId, l.quantity])), { [v.a]: 4, [v.b]: 5, [v.c]: 1 })
  })

  test("an existing account bag keeps its items, and the same item keeps the larger quantity", async () => {
    const address = email()
    const device = await signInCustomer(ctx, address)
    await add(device, v.a, 3)
    await add(device, v.c, 1)
    const guest = await guestWith([[v.a, 1], [v.b, 2], [v.c, 4]])
    await signInCustomer(ctx, address, { jar: guest.jar })
    assert.deepEqual(quantities(await bag(guest.jar)), { [v.a]: 3, [v.c]: 4, [v.b]: 2 })
    assert.deepEqual(quantities(await bag(device)), quantities(await bag(guest.jar)), "the other device sees the same bag")
  })

  test("a guest bag never passes to the next user of the same browser", async () => {
    const guest = await guestWith([[v.b, 3]])
    const first = email()
    const second = email()
    await signInCustomer(ctx, first, { jar: guest.jar })
    await signOut(guest.jar)
    // The second person signs in on the same browser, and also with the old guest cookie replayed.
    await signInCustomer(ctx, second, { jar: guest.jar })
    assert.equal(await bag(guest.jar), null, "the second user has no bag")
    const replay = await signInCustomer(ctx, second, { jar: new Jar({ chaanavya_guest: guest.token }) })
    assert.equal(await bag(replay), null)
    const firstUser = await ctx.db.user.findUniqueOrThrow({ where: { email: first } })
    const secondUser = await ctx.db.user.findUniqueOrThrow({ where: { email: second } })
    assert.equal(await ctx.db.cart.count({ where: { userId: secondUser.id } }), 0)
    const firstCart = await ctx.db.cart.findFirstOrThrow({ where: { userId: firstUser.id }, include: { lines: true } })
    assert.deepEqual(firstCart.lines.map(l => [l.variantId, l.quantity]), [[v.b, 3]], "the first user's bag is intact")
  })

  test("after signing out, an anonymous add starts a brand-new guest, not the old one", async () => {
    const guest = await guestWith([[v.a, 1]])
    await signInCustomer(ctx, email(), { jar: guest.jar })
    await signOut(guest.jar)
    const res = await add(guest.jar, v.d)
    assert.equal(res.status, 200)
    const token = guest.jar.cookies.get("chaanavya_guest")
    assert.ok(token && token !== guest.token, "a new guest cookie")
    assert.deepEqual(res.json.data.lines.map(l => l.variantId), [v.d], "an empty new guest bag plus the new item")
  })

  test("an unverified or disabled account merges nothing and the guest keeps its bag", async () => {
    const guest = await guestWith([[v.c, 2]])
    const address = email()
    await signInCustomer(ctx, address)
    const user = await ctx.db.user.findUniqueOrThrow({ where: { email: address } })
    for (const data of [{ emailVerified: false }, { emailVerified: true, disabledAt: new Date() }]) {
      await ctx.db.user.update({ where: { id: user.id }, data })
      const outcome = await merge.mergeGuestCart(ctx.db, { userId: user.id, guestToken: guest.token, correlationId: randomUUID() })
      assert.equal(outcome.status, "skipped")
    }
    assert.equal(await ctx.db.cart.count({ where: { userId: user.id } }), 0)
    assert.deepEqual(quantities(await bag(guest.jar)), { [v.c]: 2 }, "the guest bag is untouched")
  })

  test("a made-up guest cookie at sign-in merges nothing, is cleared, and sign-in still works", async () => {
    const jar = new Jar({ chaanavya_guest: "A".repeat(43) })
    await signInCustomer(ctx, email(), { jar })
    assert.equal(jar.has("chaanavya_guest"), false)
    assert.equal(await bag(jar), null)
  })

  test("an emptied guest bag ends the session without creating an account bag", async () => {
    const guest = await guestWith([[v.a, 1]])
    const lineId = (await bag(guest.jar)).lines[0].id
    await call(forward, `/api/cart/lines/${lineId}`, { method: "DELETE", jar: guest.jar, ip: newIp() })
    const address = email()
    await signInCustomer(ctx, address, { jar: guest.jar })
    const user = await ctx.db.user.findUniqueOrThrow({ where: { email: address } })
    assert.equal(await ctx.db.cart.count({ where: { userId: user.id } }), 0)
    assert.ok((await ctx.db.guestSession.findUniqueOrThrow({ where: { id: guest.cart.guestSessionId } })).revokedAt)
    assert.equal(guest.jar.has("chaanavya_guest"), false)
  })

  test("over the line limit, account lines stay and the rest are reported as left behind", async () => {
    const extra = []
    for (let i = 0; i < 32; i++) extra.push(await variant(`fixture-limit-${i}`))
    const address = email()
    const device = await signInCustomer(ctx, address)
    for (const id of extra.slice(0, 29)) await add(device, id)
    const guest = await guestWith(extra.slice(29).map(id => [id, 1]))
    await signInCustomer(ctx, address, { jar: guest.jar })
    const account = await bag(guest.jar)
    assert.equal(account.lines.length, 30)
    for (const id of extra.slice(0, 29)) assert.ok(account.lines.some(l => l.variantId === id))
    const user = await ctx.db.user.findUniqueOrThrow({ where: { email: address } })
    const event = await ctx.db.auditEvent.findFirstOrThrow({ where: { action: "cart.merged", actorId: user.id } })
    assert.deepEqual(event.after, { added: 1, raised: 0, leftBehind: 2, promotion: "none" })
  })
})
