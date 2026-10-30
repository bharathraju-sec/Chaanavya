// CHV-S13-M12: staff order reads (apps/api/src/modules/order-admin.controller.ts, apps/api/src/orders/admin.ts)
// called directly, through the web host's forwarder. Visitors, customers (even the order's own buyer), staff
// without a two-factor session and cross-site callers are refused on every route. Staff see the buyer masked;
// the full contact needs customers.read (ADMIN and OWNER; STAFF see masked only) and every read of it is audited. Filters are checked, not ignored,
// and the routes change nothing. Tax values are synthetic test values; delivery is the sandbox courier.
import { after, before, describe, test } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import "reflect-metadata"
import { apiModule, authCall, call, createStaff, Jar, newIp, setup, signInCustomer, staffWithMfa } from "../auth/helpers.mjs"

let ctx, customer, staff, admin, owner, noTwoFactor
let guestOrder, customerOrder
let n = 0

const forward = () => ctx.routes.me.GET
const admin_ = (path, { jar, origin, method = "GET" } = {}) => call(forward(), `/api/admin/orders${path}`, { method, jar, ip: newIp(), ...(origin !== undefined && { origin }) })
const cart = (method, path, { jar, body, headers = {} } = {}) => call(forward(), `/api/cart${path}`, { method, jar, body, headers, ip: newIp() })
const address = { name: "Synthetic Buyer", phone: "+91 61234 56789", line1: "12 Fixture Lane", line2: "Block C", landmark: "Near the test tower", city: "Bengaluru", district: "Bengaluru Urban", stateCode: "IN-KA", pinCode: "560034" }

/** A pending order for one item, placed by `jar` (a guest unless the jar is signed in). */
async function placeOrder(jar, email) {
  n += 1
  const p = await ctx.db.product.create({
    data: { handle: `fixture-admin-orders-${n}`, title: `Fixture admin order ${n}`, status: "active", publishedAt: new Date(), shippingRestriction: "none", variants: { create: [{ sku: `fixture-admin-orders-${n}-m`, title: "M", optionKey: "size:m", pricePaise: 99900n, taxCategory: "apparel_cotton", weightGrams: 300 }] } },
    include: { variants: true },
  })
  await ctx.db.inventoryBalance.create({ data: { variantId: p.variants[0].id, onHand: 5, lastCountedAt: new Date() } })
  assert.equal((await cart("POST", "/lines", { jar, body: { variantId: p.variants[0].id, quantity: 1 }, headers: { "idempotency-key": randomUUID() } })).status, 200)
  assert.equal((await cart("PUT", "/contact", { jar, body: { email, shippingAddress: address } })).status, 200)
  const quote = (await cart("POST", "/quote", { jar, body: {} })).json.data
  const res = await cart("POST", "/order", { jar, body: { quoteId: quote.id, expectedGrandTotal: quote.grandTotal }, headers: { "idempotency-key": randomUUID() } })
  assert.equal(res.status, 201, JSON.stringify(res.json))
  return res.json.data
}

before(async () => {
  ctx = await setup("chaanavya_test_s13_admin_orders")
  staff = await staffWithMfa(ctx, "s13.orders.staff@example.com", "STAFF")
  admin = await staffWithMfa(ctx, "s13.orders.admin@example.com", "ADMIN")
  owner = await staffWithMfa(ctx, "s13.orders.owner@example.com", "OWNER")
  // A staff member who has not enrolled two-factor: password sign-in gives a session, but not a privileged one.
  const bare = await createStaff(ctx, "s13.orders.nomfa@example.com", "ADMIN")
  noTwoFactor = new Jar()
  assert.equal((await authCall(ctx, "/sign-in/email", { body: { email: "s13.orders.nomfa@example.com", password: bare.password }, jar: noTwoFactor, ip: newIp() })).status, 200)
  await ctx.db.taxProfile.create({ data: { sellerStateCode: "IN-KA", pricesIncludeTax: true, note: "synthetic test values", createdById: owner.user.id, rates: { create: [{ taxCategory: "apparel_cotton", hsnCode: "6204", rateBasisPoints: 500 }] } } })
  guestOrder = await placeOrder(new Jar(), "guest.buyer@example.com")
  customer = await signInCustomer(ctx, "s13.orders.customer@example.com")
  customerOrder = await placeOrder(customer, "s13.orders.customer@example.com")
})
after(() => ctx?.teardown())

const contact = (order, options = {}) => admin_(`/${order.id}/contact`, { method: "POST", ...options })
const routes = () => [["GET", ""], ["GET", `/${guestOrder.id}`], ["POST", `/${guestOrder.id}/contact`], ["GET", `/${customerOrder.id}`], ["POST", `/${customerOrder.id}/contact`]]

describe("CHV-S13-M12 staff permission boundaries hold on direct API calls", () => {
  test("visitors 401; customers 403, even the order's own buyer; staff without two-factor 403", async () => {
    for (const [method, path] of routes()) {
      assert.equal((await admin_(path, { method })).status, 401, `visitor ${method} ${path}`)
      const c = await admin_(path, { method, jar: customer })
      assert.equal(c.status, 403, `customer ${method} ${path}`)
      assert.ok(!JSON.stringify(c.json).includes("Synthetic"), "a refusal carries no order data")
      const m = await admin_(path, { method, jar: noTwoFactor })
      assert.deepEqual([m.status, m.json.error], [403, "mfa_required"], `no two-factor ${method} ${path}`)
    }
  })

  test("a cross-site contact read is refused before anything is read or recorded, even with an owner's session", async () => {
    const before_ = await ctx.db.auditEvent.count({ where: { action: "customer.contact_viewed" } })
    for (const origin of ["https://evil.example", "null"]) {
      const res = await contact(guestOrder, { jar: owner.jar, origin })
      assert.deepEqual([res.status, res.json.error], [403, "cross_site"], origin)
    }
    assert.equal((await contact(guestOrder, { jar: owner.jar, method: "GET" })).status, 404, "there is no GET form to link to or prefetch")
    assert.equal(await ctx.db.auditEvent.count({ where: { action: "customer.contact_viewed" } }), before_)
  })

  test("staff, admins and owners read the list and an order; the routes are read-only", async () => {
    for (const who of [staff, admin, owner]) {
      const list = await admin_("", { jar: who.jar })
      assert.equal(list.status, 200)
      assert.equal(list.response.headers.get("cache-control"), "no-store")
      assert.ok(list.json.data.some(o => o.id === guestOrder.id) && list.json.data.some(o => o.id === customerOrder.id))
      assert.equal((await admin_(`/${guestOrder.id}`, { jar: who.jar })).status, 200)
    }
    const before = await ctx.db.order.findUniqueOrThrow({ where: { id: guestOrder.id } })
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await admin_(`/${guestOrder.id}`, { jar: owner.jar, method })
      assert.ok(res.status >= 400 && res.status !== 500, `${method} ${res.status}`)
    }
    const after_ = await ctx.db.order.findUniqueOrThrow({ where: { id: guestOrder.id } })
    assert.deepEqual([after_.status, after_.fulfilmentStatus, after_.updatedAt.getTime()], [before.status, before.fulfilmentStatus, before.updatedAt.getTime()], "reading changed nothing")
  })

  test("an unknown or malformed order id is the same 404", async () => {
    for (const id of [randomUUID(), "not-a-uuid", "1 OR 1=1"]) {
      assert.equal((await admin_(`/${encodeURIComponent(id)}`, { jar: owner.jar })).status, 404, id)
      assert.equal((await contact({ id: encodeURIComponent(id) }, { jar: owner.jar })).status, 404, `${id}/contact`)
    }
  })

  test("the contact route requires customers.read; the list and order need only orders.read", async () => {
    const { OrderAdminController } = await apiModule("modules/order-admin.controller")
    const rule = name => Reflect.getMetadata("chaanavya:access", OrderAdminController.prototype[name])
    assert.deepEqual([rule("list"), rule("one"), rule("contact")], [{ kind: "permission", capability: "orders.read" }, { kind: "permission", capability: "orders.read" }, { kind: "permission", capability: "customers.read" }])
  })
})

describe("CHV-S13-M12 personal data is masked, and full contact reads are on record", () => {
  test("the list and the order show the buyer masked: no full name, email, phone or street anywhere", async () => {
    const list = (await admin_("", { jar: staff.jar })).json.data
    const one = (await admin_(`/${guestOrder.id}`, { jar: staff.jar })).json.data
    const listed = list.find(o => o.id === guestOrder.id)
    for (const view of [listed, one]) {
      assert.deepEqual(view.buyer, { kind: "guest", name: "Synthetic B.", email: "g***@example.com", phone: "******6789" })
      assert.deepEqual(view.deliverTo, { city: "Bengaluru", stateCode: "IN-KA", pinCode: "560034" })
    }
    assert.equal(list.find(o => o.id === customerOrder.id).buyer.kind, "customer")
    const text = JSON.stringify({ list, one })
    for (const secret of ["guest.buyer@example.com", "s13.orders.customer@example.com", "Synthetic Buyer", "61234", "12 Fixture Lane", "Block C", "test tower", "submitKey", "providerPaymentId"]) assert.ok(!text.includes(secret), `"${secret}" must not appear`)
  })

  test("the order view carries what staff need: items, totals in paise, payment, stock hold and its trail", async () => {
    const one = (await admin_(`/${guestOrder.id}`, { jar: staff.jar })).json.data
    assert.equal(one.number, guestOrder.number)
    assert.deepEqual([one.status, one.fulfilmentStatus], ["pending_payment", "unfulfilled"])
    assert.equal(one.totals.grandTotal.amountPaise, guestOrder.grandTotal.amountPaise)
    assert.equal(one.items.length, 1)
    assert.equal(one.items[0].quantity, 1)
    assert.equal(one.stockHold.status, "active")
    assert.deepEqual(one.payments, [])
    assert.deepEqual(one.exceptions, [])
    assert.equal(one.events[0].kind, "placed")
  })

  test("the full contact, for admins and owners (customers.read); every read writes an audit event naming who looked", async () => {
    const before_ = await ctx.db.auditEvent.count({ where: { action: "customer.contact_viewed", entityId: guestOrder.id } })
    const res = await contact(guestOrder, { jar: admin.jar })
    assert.equal(res.status, 200)
    assert.equal(res.response.headers.get("cache-control"), "no-store")
    // The phone as checkout stored it (E.164).
    assert.deepEqual(res.json.data, { name: "Synthetic Buyer", email: "guest.buyer@example.com", phone: "+916123456789", shippingAddress: { ...address, phone: "+916123456789" }, billingAddress: null })
    await contact(guestOrder, { jar: owner.jar })
    const events = await ctx.db.auditEvent.findMany({ where: { action: "customer.contact_viewed", entityId: guestOrder.id }, orderBy: { occurredAt: "asc" }, select: { actorKind: true, actorId: true, entityType: true, after: true } })
    assert.equal(events.length - before_, 2, "two reads, two records")
    assert.deepEqual(events.slice(-2).map(e => [e.actorKind, e.actorId, e.entityType]), [["staff", admin.user.id, "order"], ["staff", owner.user.id, "order"]])
    assert.ok(!JSON.stringify(events).includes("guest.buyer@example.com"), "the record says which fields were read, not their values")
  })

  test("STAFF see the buyer masked only: a STAFF contact read is 403 and nothing is recorded", async () => {
    const before_ = await ctx.db.auditEvent.count({ where: { action: "customer.contact_viewed", entityId: guestOrder.id } })
    const res = await contact(guestOrder, { jar: staff.jar })
    assert.equal(res.status, 403)
    assert.ok(!JSON.stringify(res.json).includes("guest.buyer@example.com"), "the refusal carries no contact")
    assert.equal(await ctx.db.auditEvent.count({ where: { action: "customer.contact_viewed", entityId: guestOrder.id } }), before_)
  })

  test("a refused contact read is not recorded as a view", async () => {
    const before_ = await ctx.db.auditEvent.count({ where: { action: "customer.contact_viewed", entityId: customerOrder.id } })
    for (const jar of [undefined, customer, noTwoFactor, staff.jar]) assert.ok((await contact(customerOrder, { jar })).status >= 400)
    assert.equal(await ctx.db.auditEvent.count({ where: { action: "customer.contact_viewed", entityId: customerOrder.id } }), before_)
  })
})

describe("CHV-S13-M12 filters are checked and pages are stable", () => {
  test("status, payment status and order number filters", async () => {
    const pending = (await admin_("?status=pending_payment", { jar: staff.jar })).json.data
    assert.ok(pending.length >= 2 && pending.every(o => o.status === "pending_payment"))
    assert.deepEqual((await admin_("?status=confirmed", { jar: staff.jar })).json.data.filter(o => [guestOrder.id, customerOrder.id].includes(o.id)), [])
    await ctx.db.paymentAttempt.create({ data: { orderId: customerOrder.id, provider: "razorpay", mode: "test", amountPaise: BigInt(customerOrder.grandTotal.amountPaise), idempotencyKey: randomUUID() } })
    assert.deepEqual((await admin_("?paymentStatus=created", { jar: staff.jar })).json.data.map(o => o.id), [customerOrder.id])
    assert.deepEqual((await admin_(`?number=${guestOrder.number.toLowerCase()}`, { jar: staff.jar })).json.data.map(o => o.id), [guestOrder.id])
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
    assert.deepEqual((await admin_(`?placedFrom=${tomorrow}`, { jar: staff.jar })).json.data, [])
  })

  test("a bad filter is refused, not ignored", async () => {
    for (const q of ["status=shipped", "fulfilmentStatus=lost", "paymentStatus=paid", "placedFrom=yesterday", "placedTo=2026-13-45", "number=1001", "number=CHV-1%20OR%201", "limit=0", "limit=101", "cursor=%25%25"]) {
      const res = await admin_(`?${q}`, { jar: staff.jar })
      assert.equal(res.status, 400, q)
    }
    const forged = Buffer.from(JSON.stringify({ createdAt: "not a date", id: "x" })).toString("base64url")
    assert.equal((await admin_(`?cursor=${forged}`, { jar: staff.jar })).status, 400)
  })

  test("paging one at a time visits each order once, newest first", async () => {
    const seen = []
    let cursor = null
    do {
      const res = await admin_(`?limit=1${cursor ? `&cursor=${cursor}` : ""}`, { jar: staff.jar })
      assert.equal(res.status, 200)
      seen.push(...res.json.data.map(o => o.id))
      cursor = res.json.page.nextCursor
    } while (cursor)
    const all = (await ctx.db.order.findMany({ orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true } })).map(o => o.id)
    assert.deepEqual(seen, all)
  })
})
