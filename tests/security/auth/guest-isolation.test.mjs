// CHV-S05-001: a guest cannot read another guest's cart or order. Also: guests and customers are
// isolated from each other, guest tokens are stored hashed, and a guest is never staff.
import { after, before, describe, test } from "node:test"
import assert from "node:assert/strict"
import { createHash, randomBytes } from "node:crypto"
import { apiModule, call, Jar, orderData, setup, signInCustomer } from "./helpers.mjs"

let ctx
const guests = {}
let customerJar, customerOrder

before(async () => {
  ctx = await setup("chaanavya_test_s05_guest")
  for (const name of ["a", "b"]) {
    const { session, token } = await ctx.guest.createGuestSession(ctx.db)
    const order = await ctx.db.order.create({ data: orderData({ guestSessionId: session.id, email: `guest.${name}@example.com` }) })
    const cart = await ctx.db.cart.create({ data: { guestSessionId: session.id, expiresAt: new Date(Date.now() + 86_400_000) } })
    guests[name] = { session, token, order, cart, jar: new Jar({ [ctx.guest.GUEST_COOKIE]: token }) }
  }
  customerJar = await signInCustomer(ctx, "isolation.customer@example.com")
  const customer = await ctx.db.user.findUniqueOrThrow({ where: { email: "isolation.customer@example.com" } })
  customerOrder = await ctx.db.order.create({ data: orderData({ userId: customer.id, email: customer.email }) })
})
after(() => ctx?.teardown())

const readOrder = (id, jar) => call(ctx.routes.order.GET, `/api/orders/${id}`, { jar, params: { id } })

describe("CHV-S05-001 guest isolation", () => {
  test("a guest reads their own order", async () => {
    const res = await readOrder(guests.a.order.id, guests.a.jar)
    assert.equal(res.status, 200)
    assert.equal(res.json.number, guests.a.order.number)
  })

  test("a guest cannot read another guest's order, and the refusal looks like a missing order", async () => {
    const res = await readOrder(guests.b.order.id, guests.a.jar)
    assert.equal(res.status, 404)
    assert.deepEqual(res.json, { error: "not_found" })
    assert.deepEqual((await readOrder("01a13f03-0000-7000-8000-000000000000", guests.a.jar)).json, res.json)
  })

  test("no cookie, a made-up token or a malformed token reads nothing", async () => {
    for (const jar of [new Jar(), new Jar({ [ctx.guest.GUEST_COOKIE]: randomBytes(32).toString("base64url") }), new Jar({ [ctx.guest.GUEST_COOKIE]: "not-a-token" })]) {
      assert.equal((await readOrder(guests.a.order.id, jar)).status, 404)
    }
  })

  test("the database hash alone is not a working cookie", async () => {
    const stored = await ctx.db.guestSession.findUniqueOrThrow({ where: { id: guests.a.session.id } })
    assert.notEqual(stored.tokenHash, guests.a.token)
    assert.equal(stored.tokenHash, createHash("sha256").update(guests.a.token).digest("hex"))
    assert.equal((await readOrder(guests.a.order.id, new Jar({ [ctx.guest.GUEST_COOKIE]: stored.tokenHash }))).status, 404)
  })

  test("expired or revoked guest sessions read nothing", async () => {
    const { session, token } = await ctx.guest.createGuestSession(ctx.db)
    const order = await ctx.db.order.create({ data: orderData({ guestSessionId: session.id }) })
    const jar = new Jar({ [ctx.guest.GUEST_COOKIE]: token })
    assert.equal((await readOrder(order.id, jar)).status, 200)
    await ctx.guest.revokeGuestSession(ctx.db, session.id)
    assert.equal((await readOrder(order.id, jar)).status, 404)
    const second = await ctx.guest.createGuestSession(ctx.db)
    const order2 = await ctx.db.order.create({ data: orderData({ guestSessionId: second.session.id }) })
    await ctx.db.guestSession.update({ where: { id: second.session.id }, data: { expiresAt: new Date(Date.now() - 1000) } })
    assert.equal((await readOrder(order2.id, new Jar({ [ctx.guest.GUEST_COOKIE]: second.token }))).status, 404)
  })

  test("guests and customers cannot read each other's orders", async () => {
    assert.equal((await readOrder(customerOrder.id, guests.a.jar)).status, 404)
    assert.equal((await readOrder(guests.a.order.id, customerJar)).status, 404)
    assert.equal((await readOrder(customerOrder.id, customerJar)).status, 200)
    const list = await call(ctx.routes.accountOrders.GET, "/api/account/orders", { jar: customerJar })
    assert.deepEqual(list.json.orders.map(o => o.id), [customerOrder.id])
  })

  test("cart ownership follows the same rule", async () => {
    const shopperA = { userId: null, guestSessionId: guests.a.session.id }
    const { ownsRecord } = await apiModule("auth/session")
    assert.equal(ownsRecord(shopperA, guests.a.cart), true)
    assert.equal(ownsRecord(shopperA, guests.b.cart), false)
    assert.equal(ownsRecord({ userId: null, guestSessionId: null }, { userId: null, guestSessionId: null }), false, "two anonymous nulls never match")
  })

  test("a guest is never staff: admin and account routes refuse a guest cookie", async () => {
    assert.equal((await call(ctx.routes.me.GET, "/api/admin/me", { jar: guests.a.jar })).status, 401)
    assert.equal((await call(ctx.routes.audit.GET, "/api/admin/audit", { jar: guests.a.jar })).status, 401)
    assert.equal((await call(ctx.routes.accountOrders.GET, "/api/account/orders", { jar: guests.a.jar })).status, 401)
  })
})
