// Pre-Stage-12 maintenance fixes (handover of 25 October 2026), CHV-S11-F01 to F04:
//   F01 one live cart per owner, even when first adds race
//   F02 a successful add retried with the same key stays a success after stock or publication change
//   F03 the promo code is carried through the sign-in merge (account code wins), checked as the account
//   F04 a malformed guest cookie is ignored and cleared, never a server error
// Real API in-process behind the web host's forwarder, real email-code sign-in, throwaway database.
import { after, before, describe, test } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { apiModule, authCall, call, Jar, newIp, orderData, setup, signInCustomer } from "../auth/helpers.mjs"

let ctx, forward, merge
const v = {}
const DAY = 86_400_000
let emails = 0
const email = () => `maint${++emails}@example.com`

async function variant(handle, { pricePaise = 200000n, onHand = 50 } = {}) {
  const created = await ctx.db.product.create({
    data: { handle, title: `Fixture ${handle}`, status: "active", publishedAt: new Date(), variants: { create: [{ sku: `${handle}-m`, title: "M", optionKey: "size:m", pricePaise }] } },
    include: { variants: true },
  })
  await ctx.db.inventoryBalance.create({ data: { variantId: created.variants[0].id, onHand, lastCountedAt: new Date() } })
  return { id: created.variants[0].id, productId: created.id }
}
const promo = (code, data = {}) => ctx.db.promotion.create({ data: { code, kind: "percent", percentBasisPoints: 1000, startsAt: new Date(Date.now() - DAY), active: true, ...data } })

const add = (jar, variantId, quantity = 1, key = randomUUID()) => call(forward, "/api/cart/lines", { method: "POST", jar, body: { variantId, quantity }, headers: { "idempotency-key": key }, ip: newIp() })
const bag = async jar => (await call(forward, "/api/cart", { jar, ip: newIp() })).json.data
const applyCode = (jar, code) => call(forward, "/api/cart/promotion", { method: "POST", jar, body: { code }, ip: newIp() })
const liveCarts = where => ctx.db.cart.count({ where: { ...where, expiresAt: { gt: new Date() } } })
const quantities = b => Object.fromEntries((b?.lines ?? []).map(l => [l.variantId, l.quantity]))

before(async () => {
  ctx = await setup("chaanavya_test_s11_maintenance")
  forward = ctx.routes.me.GET
  merge = await apiModule("cart/merge-apply")
  v.a = (await variant("fixture-maint-a")).id
  v.b = (await variant("fixture-maint-b")).id
  v.c = (await variant("fixture-maint-c")).id
})
after(() => ctx?.teardown())

describe("CHV-S11-F01 one live cart per owner", () => {
  test("F01-A: parallel first adds for one verified account leave exactly one live cart holding every add", async () => {
    const address = email()
    const device = await signInCustomer(ctx, address)
    const user = await ctx.db.user.findUniqueOrThrow({ where: { email: address } })
    const results = await Promise.all([add(device, v.a), add(device, v.b), add(device, v.c), add(device, v.a, 2)])
    for (const r of results) assert.equal(r.status, 200, JSON.stringify(r.json))
    assert.equal(await liveCarts({ userId: user.id }), 1)
    assert.deepEqual(quantities(await bag(device)), { [v.a]: 3, [v.b]: 1, [v.c]: 1 })
    assert.equal(new Set(results.map(r => r.json.data.id)).size, 1, "every response names the same cart")
  })

  test("F01-A: the same for a guest session: parallel first adds with one cookie give one cart", async () => {
    const { session, token } = await ctx.guest.createGuestSession(ctx.db)
    const jar = new Jar({ chaanavya_guest: token })
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => add(jar, [v.a, v.b, v.c][i % 3])))
    for (const r of results) assert.equal(r.status, 200, JSON.stringify(r.json))
    assert.equal(await liveCarts({ guestSessionId: session.id }), 1)
    assert.deepEqual(quantities(await bag(jar)), { [v.a]: 2, [v.b]: 2, [v.c]: 1 })
  })

  test("F01-B: guest adds racing the sign-in merge, and account adds racing it, leave one account cart and no deadlock", async () => {
    const { session, token } = await ctx.guest.createGuestSession(ctx.db)
    const guestJar = new Jar({ chaanavya_guest: token })
    await add(guestJar, v.a, 2)
    const address = email()
    const device = await signInCustomer(ctx, address)
    const user = await ctx.db.user.findUniqueOrThrow({ where: { email: address } })
    const work = [
      merge.mergeGuestCart(ctx.db, { userId: user.id, guestToken: token, correlationId: randomUUID() }),
      merge.mergeGuestCart(ctx.db, { userId: user.id, guestToken: token, correlationId: randomUUID() }),
      add(device, v.b),
      add(device, v.c),
      add(guestJar, v.b),
    ]
    const outcomes = await Promise.race([Promise.all(work), new Promise((_, reject) => setTimeout(() => reject(new Error("deadlock: did not finish in 20 s")), 20_000))])
    assert.deepEqual(outcomes.slice(0, 2).map(o => o.status).sort(), ["merged", "no_guest"], "merged exactly once")
    assert.equal(await liveCarts({ userId: user.id }), 1, "one account cart")
    const account = await bag(device)
    assert.equal(quantities(account)[v.a], 2, "the guest's item arrived once")
    assert.equal(quantities(account)[v.b], 1)
    assert.equal(quantities(account)[v.c], 1)
    // The guest's late add either landed before the merge (and was merged) or after it (and was
    // refused because the session ended); it never created a second guest cart.
    assert.ok(await liveCarts({ guestSessionId: session.id }) <= 1)
  })
})

describe("CHV-S11-F02 idempotent add replays", () => {
  test("F02-A: an add retried with the same key and body after stock runs out is a successful no-op", async () => {
    const item = await variant("fixture-maint-stockout", { onHand: 2 })
    const jar = new Jar()
    const key = randomUUID()
    const first = await add(jar, item.id, 2, key)
    assert.equal(first.status, 200)
    await ctx.db.inventoryBalance.update({ where: { variantId: item.id }, data: { reserved: 2 } })
    const retry = await add(jar, item.id, 2, key)
    assert.equal(retry.status, 200, JSON.stringify(retry.json))
    assert.deepEqual(retry.json.data, first.json.data, "the same bag, same revision: nothing written")
    assert.equal((await add(jar, item.id, 1)).status, 409, "a new key is still refused: sold out")
  })

  test("F02-B: the same retry after the product is unpublished or archived is a no-op; a fresh key still fails", async () => {
    for (const change of [{ publishedAt: null }, { status: "archived" }]) {
      const item = await variant(`fixture-maint-hidden-${change.status ?? "unpublished"}`)
      const jar = new Jar()
      const key = randomUUID()
      const first = await add(jar, item.id, 1, key)
      await ctx.db.product.update({ where: { id: item.productId }, data: change })
      const retry = await add(jar, item.id, 1, key)
      assert.equal(retry.status, 200, JSON.stringify(change))
      assert.equal(retry.json.data.revision, first.json.data.revision)
      assert.equal(retry.json.data.lines.length, 1, "no second line")
      assert.equal((await add(jar, item.id, 1)).status, 404, "a new add of a hidden item reads as missing")
    }
  })

  test("F02-C: the same key with a different body is 409, and parallel identical requests apply once", async () => {
    const jar = new Jar()
    const key = randomUUID()
    await add(jar, v.a, 1, key)
    const other = await add(jar, v.a, 2, key)
    assert.equal(other.status, 409)
    assert.equal(other.json.error.fields["Idempotency-Key"], "reused")
    assert.equal((await add(jar, v.b, 1, key)).status, 409, "a different item with the same key too")
    const before = await bag(jar)
    const parallelKey = randomUUID()
    const results = await Promise.all(Array.from({ length: 6 }, () => add(jar, v.c, 2, parallelKey)))
    for (const r of results) assert.equal(r.status, 200)
    const after = await bag(jar)
    assert.equal(quantities(after)[v.c], 2, "applied once")
    assert.equal(after.revision, before.revision + 1)
  })

  test("F02: a replay never creates a guest session or a cart, and a body missing quantity matches quantity 1", async () => {
    const jar = new Jar()
    const key = randomUUID()
    await add(jar, v.a, 1, key)
    const sessions = await ctx.db.guestSession.count()
    const carts = await ctx.db.cart.count()
    const same = await call(forward, "/api/cart/lines", { method: "POST", jar, body: { variantId: v.a }, headers: { "idempotency-key": key }, ip: newIp() })
    assert.equal(same.status, 200)
    assert.equal(await ctx.db.guestSession.count(), sessions)
    assert.equal(await ctx.db.cart.count(), carts)
  })
})

describe("CHV-S11-F03 promo code through sign-in", () => {
  test("F03-A: a guest-only code survives sign-in and is checked as the account", async () => {
    await promo("GUESTTEN")
    const guest = new Jar()
    await add(guest, v.a, 2)
    assert.equal((await applyCode(guest, "GUESTTEN")).status, 200)
    const address = email()
    await signInCustomer(ctx, address, { jar: guest })
    const account = await bag(guest)
    assert.deepEqual(account.promotion, { code: "GUESTTEN", applied: true })
    assert.equal(account.discount.amountPaise, Math.floor(account.subtotal.amountPaise / 10))
    const user = await ctx.db.user.findUniqueOrThrow({ where: { email: address } })
    const event = await ctx.db.auditEvent.findFirstOrThrow({ where: { action: "cart.merged", actorId: user.id } })
    assert.equal(event.after.promotion, "carried")
  })

  test("F03-A: a carried code the account may not use shows with its reason and gives no discount", async () => {
    const p = await promo("ONCEPERPERSON", { perCustomerLimit: 1 })
    const address = email()
    const earlier = await signInCustomer(ctx, address)
    const user = await ctx.db.user.findUniqueOrThrow({ where: { email: address } })
    await signOutJar(earlier)
    await ctx.db.order.create({ data: orderData({ email: address, userId: user.id, promotionId: p.id, status: "confirmed" }) })
    const guest = new Jar()
    await add(guest, v.b)
    assert.equal((await applyCode(guest, "ONCEPERPERSON")).status, 200, "the guest session has not used it")
    await signInCustomer(ctx, address, { jar: guest })
    const account = await bag(guest)
    assert.deepEqual(account.promotion, { code: "ONCEPERPERSON", applied: false, reason: "per_customer_limit_reached" }, "the account's own use counts, not the guest session's")
    assert.equal(account.discount.amountPaise, 0)
  })

  test("F03-B: the account's own code wins over the guest's, and codes never stack", async () => {
    await promo("ACCOUNT15", { percentBasisPoints: 1500 })
    await promo("GUEST20", { percentBasisPoints: 2000 })
    const address = email()
    const device = await signInCustomer(ctx, address)
    await add(device, v.a)
    assert.equal((await applyCode(device, "ACCOUNT15")).status, 200)
    const guest = new Jar()
    await add(guest, v.b)
    await applyCode(guest, "GUEST20")
    await signInCustomer(ctx, address, { jar: guest })
    const account = await bag(guest)
    assert.deepEqual(account.promotion, { code: "ACCOUNT15", applied: true })
    assert.equal(account.discount.amountPaise, Math.floor((account.subtotal.amountPaise * 1500) / 10000), "only the account's code")
    const user = await ctx.db.user.findUniqueOrThrow({ where: { email: address } })
    const event = await ctx.db.auditEvent.findFirstOrThrow({ where: { action: "cart.merged", actorId: user.id } })
    assert.equal(event.after.promotion, "account_kept")
  })

  test("F03-B: an expired carried code never discounts", async () => {
    await promo("SOONGONE")
    const guest = new Jar()
    await add(guest, v.c)
    await applyCode(guest, "SOONGONE")
    await ctx.db.promotion.update({ where: { code: "SOONGONE" }, data: { endsAt: new Date(Date.now() - 1000) } })
    await signInCustomer(ctx, email(), { jar: guest })
    const account = await bag(guest)
    assert.deepEqual(account.promotion, { code: "SOONGONE", applied: false, reason: "expired" })
    assert.equal(account.discount.amountPaise, 0)
  })

  test("F03-C: repeated and concurrent merges carry the code once and duplicate no lines", async () => {
    await promo("RACECODE")
    const { session, token } = await ctx.guest.createGuestSession(ctx.db)
    const guest = new Jar({ chaanavya_guest: token })
    await add(guest, v.a, 3)
    await applyCode(guest, "RACECODE")
    const address = email()
    await signInCustomer(ctx, address)
    const user = await ctx.db.user.findUniqueOrThrow({ where: { email: address } })
    const outcomes = await Promise.all(Array.from({ length: 4 }, () => merge.mergeGuestCart(ctx.db, { userId: user.id, guestToken: token, correlationId: randomUUID() })))
    assert.equal(outcomes.filter(o => o.status === "merged").length, 1)
    const carts = await ctx.db.cart.findMany({ where: { userId: user.id }, include: { lines: true } })
    assert.equal(carts.length, 1)
    assert.deepEqual(carts[0].lines.map(l => [l.variantId, l.quantity]), [[v.a, 3]])
    assert.equal(carts[0].promotionId, (await ctx.db.promotion.findUniqueOrThrow({ where: { code: "RACECODE" } })).id)
    const revision = carts[0].revision
    await signInCustomer(ctx, address, { jar: new Jar({ chaanavya_guest: token }) })
    const again = await ctx.db.cart.findUniqueOrThrow({ where: { id: carts[0].id } })
    assert.equal(again.revision, revision, "a second sign-in changes nothing")
    const guestCart = await ctx.db.cart.findFirstOrThrow({ where: { guestSessionId: session.id }, include: { lines: true } })
    assert.deepEqual([guestCart.lines.length, guestCart.promotionId, guestCart.userId], [0, null, null], "the guest bag was emptied, its code removed, and it stayed the guest's")
  })

  test("F03: carrying only a code still bumps the account revision", async () => {
    await promo("CODEONLY")
    const address = email()
    const device = await signInCustomer(ctx, address)
    await add(device, v.a)
    const before = await bag(device)
    const guest = new Jar()
    await add(guest, v.b)
    await applyCode(guest, "CODEONLY")
    const lineId = (await bag(guest)).lines[0].id
    await call(forward, `/api/cart/lines/${lineId}`, { method: "DELETE", jar: guest, ip: newIp() })
    await signInCustomer(ctx, address, { jar: guest })
    const after = await bag(device)
    assert.deepEqual(after.promotion, { code: "CODEONLY", applied: true })
    assert.equal(after.revision, before.revision + 1)
    assert.deepEqual(quantities(after), { [v.a]: 1 })
  })
})

const signOutJar = jar => authCall(ctx, "/sign-out", { jar, body: {}, ip: newIp() })

describe("CHV-S11-F04 malformed guest cookies", () => {
  test("F04-A: malformed, truncated or arbitrary guest cookies give normal anonymous behaviour, never a 500", async () => {
    const { token } = await ctx.guest.createGuestSession(ctx.db)
    for (const value of ["%", "%ZZ", "%E0%A4%A", token.slice(0, 20), `${token}x`, "not a token at all", "%25%25%25", "=="]) {
      const jar = new Jar({ chaanavya_guest: value })
      const read = await call(forward, "/api/cart", { jar, ip: newIp() })
      assert.equal(read.status, 200, `read with ${JSON.stringify(value)}`)
      assert.equal(read.json.data, null)
      assert.match(read.response.headers.getSetCookie().find(c => c.startsWith("chaanavya_guest=")) ?? "", /Max-Age=0/, "the bad cookie is cleared")
      const write = await add(new Jar({ chaanavya_guest: value }), v.a)
      assert.equal(write.status, 200, `add with ${JSON.stringify(value)}`)
      assert.match(write.response.headers.getSetCookie().find(c => c.startsWith("chaanavya_guest=")) ?? "", /chaanavya_guest=[A-Za-z0-9_-]{43};/, "a new guest session starts")
      for (const method of ["PATCH", "DELETE"]) assert.ok((await call(forward, `/api/cart/lines/${randomUUID()}`, { method, jar: new Jar({ chaanavya_guest: value }), body: method === "PATCH" ? { quantity: 1 } : undefined, ip: newIp() })).status < 500)
    }
    // Signing in with a malformed guest cookie works and clears it.
    const jar = new Jar({ chaanavya_guest: "%ZZ" })
    await signInCustomer(ctx, email(), { jar })
    assert.equal(jar.has("chaanavya_guest"), false)
  })

  test("F04-B: a valid guest cookie still finds its own cart", async () => {
    const jar = new Jar()
    const first = await add(jar, v.b, 2)
    const token = jar.cookies.get("chaanavya_guest")
    assert.match(token, /^[A-Za-z0-9_-]{43}$/)
    const again = await bag(new Jar({ chaanavya_guest: token }))
    assert.equal(again.id, first.json.data.id)
    assert.deepEqual(quantities(again), { [v.b]: 2 })
  })
})
