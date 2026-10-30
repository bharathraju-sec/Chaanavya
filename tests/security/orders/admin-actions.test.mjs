// CHV-S13-M13: limited staff actions on an order (apps/api/src/orders/admin-actions.ts), called directly through
// the web host's forwarder: hold, release and internal notes. Only ADMIN and OWNER (orders.manage, two-factor,
// same origin) may act. A repeated action is either idempotent (same Idempotency-Key: the first result, nothing
// written again) or safely refused (409 already in that state, 412 stale ETag), and racing actions apply once.
// Every change is audited. A hold stops fulfilment moving forward, in the API and in the database.
// Tax values are synthetic test values; delivery is the sandbox courier.
import { after, before, describe, test } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import "reflect-metadata"
import { apiModule, authCall, call, createStaff, Jar, newIp, setup, signInCustomer, staffWithMfa } from "../auth/helpers.mjs"

let ctx, customer, staff, admin, owner, noTwoFactor
let n = 0

const forward = () => ctx.routes.me.GET
const api = (path, { jar, origin, method = "GET", body, headers = {} } = {}) => call(forward(), `/api/admin/orders${path}`, { method, jar, body, headers, ip: newIp(), ...(origin !== undefined && { origin }) })
const cart = (method, path, { jar, body, headers = {} } = {}) => call(forward(), `/api/cart${path}`, { method, jar, body, headers, ip: newIp() })
const address = { name: "Synthetic Buyer", phone: "+91 61234 56789", line1: "12 Fixture Lane", line2: null, landmark: null, city: "Bengaluru", district: "Bengaluru Urban", stateCode: "IN-KA", pinCode: "560034" }

/** A pending guest order for one item. */
async function placeOrder() {
  n += 1
  const jar = new Jar()
  const p = await ctx.db.product.create({
    data: { handle: `fixture-admin-actions-${n}`, title: `Fixture admin action ${n}`, status: "active", publishedAt: new Date(), shippingRestriction: "none", variants: { create: [{ sku: `fixture-admin-actions-${n}-m`, title: "M", optionKey: "size:m", pricePaise: 99900n, taxCategory: "apparel_cotton", weightGrams: 300 }] } },
    include: { variants: true },
  })
  await ctx.db.inventoryBalance.create({ data: { variantId: p.variants[0].id, onHand: 5, lastCountedAt: new Date() } })
  assert.equal((await cart("POST", "/lines", { jar, body: { variantId: p.variants[0].id, quantity: 1 }, headers: { "idempotency-key": randomUUID() } })).status, 200)
  assert.equal((await cart("PUT", "/contact", { jar, body: { email: `buyer${n}@example.com`, shippingAddress: address } })).status, 200)
  const quote = (await cart("POST", "/quote", { jar, body: {} })).json.data
  const res = await cart("POST", "/order", { jar, body: { quoteId: quote.id, expectedGrandTotal: quote.grandTotal }, headers: { "idempotency-key": randomUUID() } })
  assert.equal(res.status, 201, JSON.stringify(res.json))
  return res.json.data
}

/** Moves an order's status or fulfilment directly in the database, as a declared system job would. */
async function force(orderId, data) {
  await ctx.db.$transaction(async tx => {
    await tx.$queryRaw`SELECT set_config('chaanavya.origin', ${JSON.stringify({ actorKind: "system", actorId: null, correlationId: `test-${randomUUID()}` })}, true)`
    await tx.order.update({ where: { id: orderId }, data })
  })
}

const etag = async (order, jar = owner.jar) => (await api(`/${order.id}`, { jar })).response.headers.get("etag")
const hold = (order, { jar = owner.jar, ifMatch, key, reason = "buyer asked us to wait", origin } = {}) =>
  api(`/${order.id}/hold`, { method: "POST", jar, origin, body: { reason }, headers: { ...(ifMatch && { "if-match": ifMatch }), ...(key && { "idempotency-key": key }) } })
const release = (order, { jar = owner.jar, ifMatch, key, reason = "buyer confirmed the size" } = {}) =>
  api(`/${order.id}/release`, { method: "POST", jar, body: { reason }, headers: { ...(ifMatch && { "if-match": ifMatch }), ...(key && { "idempotency-key": key }) } })
const note = (order, { jar = owner.jar, text = "Called the courier about the slot", key = randomUUID(), origin } = {}) =>
  api(`/${order.id}/notes`, { method: "POST", jar, origin, body: { text }, headers: key ? { "idempotency-key": key } : {} })

const counts = async orderId => ({
  actions: await ctx.db.orderAdminAction.count({ where: { orderId } }),
  audits: await ctx.db.auditEvent.count({ where: { entityId: orderId, action: { in: ["order.held", "order.released", "order.note_added"] } } }),
  events: await ctx.db.orderEvent.count({ where: { orderId, kind: "hold" } }),
})

before(async () => {
  ctx = await setup("chaanavya_test_s13_admin_actions")
  staff = await staffWithMfa(ctx, "s13.actions.staff@example.com", "STAFF")
  admin = await staffWithMfa(ctx, "s13.actions.admin@example.com", "ADMIN")
  owner = await staffWithMfa(ctx, "s13.actions.owner@example.com", "OWNER")
  const bare = await createStaff(ctx, "s13.actions.nomfa@example.com", "ADMIN")
  noTwoFactor = new Jar()
  assert.equal((await authCall(ctx, "/sign-in/email", { body: { email: "s13.actions.nomfa@example.com", password: bare.password }, jar: noTwoFactor, ip: newIp() })).status, 200)
  customer = await signInCustomer(ctx, "s13.actions.customer@example.com")
  await ctx.db.taxProfile.create({ data: { sellerStateCode: "IN-KA", pricesIncludeTax: true, note: "synthetic test values", createdById: owner.user.id, rates: { create: [{ taxCategory: "apparel_cotton", hsnCode: "6204", rateBasisPoints: 500 }] } } })
})
after(() => ctx?.teardown())

describe("CHV-S13-M13 only admins and owners act, and only from the admin site", () => {
  test("visitors 401; customers and STAFF 403; no two-factor 403 mfa_required; cross-site 403; nothing written", async () => {
    const order = await placeOrder()
    const tag = await etag(order)
    const before_ = await counts(order.id)
    for (const path of ["hold", "release", "notes"]) {
      const send = (jar, origin) => api(`/${order.id}/${path}`, { method: "POST", jar, origin, body: { reason: "a valid reason", text: "a note" }, headers: { "if-match": tag, "idempotency-key": randomUUID() } })
      assert.equal((await send(undefined)).status, 401, `visitor ${path}`)
      assert.equal((await send(customer)).status, 403, `customer ${path}`)
      assert.equal((await send(staff.jar)).status, 403, `STAFF ${path}`)
      const m = await send(noTwoFactor)
      assert.deepEqual([m.status, m.json.error], [403, "mfa_required"], `no two-factor ${path}`)
      for (const origin of ["https://evil.example", "null"]) {
        const x = await send(owner.jar, origin)
        assert.deepEqual([x.status, x.json.error], [403, "cross_site"], `${origin} ${path}`)
      }
    }
    assert.deepEqual(await counts(order.id), before_, "a refused action writes nothing")
    assert.equal((await ctx.db.order.findUniqueOrThrow({ where: { id: order.id } })).heldAt, null)
  })

  test("the action routes declare orders.manage", async () => {
    const { OrderAdminController } = await apiModule("modules/order-admin.controller")
    const rule = name => Reflect.getMetadata("chaanavya:access", OrderAdminController.prototype[name])
    for (const name of ["hold", "release", "note"]) assert.deepEqual(rule(name), { kind: "permission", capability: "orders.manage" }, name)
  })

  test("an unknown or malformed order id is 404 and writes nothing", async () => {
    for (const id of [randomUUID(), "not-a-uuid"]) {
      assert.equal((await hold({ id }, { ifMatch: 'W/"x"' })).status, 404, `hold ${id}`)
      assert.equal((await note({ id })).status, 404, `note ${id}`)
    }
    assert.equal(await ctx.db.orderAdminAction.count({ where: { orderId: { notIn: (await ctx.db.order.findMany({ select: { id: true } })).map(o => o.id) } } }), 0)
  })
})

describe("CHV-S13-M13 hold and release: checked, audited, and safe to repeat", () => {
  test("a hold needs If-Match and a reason; it is applied once, audited and on the order's trail", async () => {
    const order = await placeOrder()
    const tag = await etag(order)
    assert.equal((await hold(order)).status, 428, "no If-Match")
    assert.equal((await hold(order, { ifMatch: 'W/"stale"' })).status, 412, "stale If-Match")
    assert.equal((await hold(order, { ifMatch: tag, reason: "x" })).status, 400, "reason too short")
    assert.deepEqual(await counts(order.id), { actions: 0, audits: 0, events: 0 })

    const res = await hold(order, { ifMatch: tag, jar: admin.jar })
    assert.equal(res.status, 200, JSON.stringify(res.json))
    assert.equal(res.json.data.held, true)
    assert.equal(res.json.data.heldBy, admin.user.id)
    assert.notEqual(res.json.data.etag, tag)
    assert.equal(res.response.headers.get("etag"), res.json.data.etag)
    assert.equal(res.response.headers.get("cache-control"), "no-store")

    const audit = await ctx.db.auditEvent.findFirstOrThrow({ where: { action: "order.held", entityId: order.id } })
    assert.deepEqual([audit.actorKind, audit.actorId, audit.entityType, audit.reason, audit.before, audit.after], ["staff", admin.user.id, "order", "buyer asked us to wait", { held: false }, { held: true }])
    const view = (await api(`/${order.id}`, { jar: staff.jar })).json.data
    assert.equal(view.hold.heldBy, admin.user.id)
    assert.deepEqual(view.staffActions.map(a => [a.kind, a.text, a.actorId]), [["hold", "buyer asked us to wait", admin.user.id]])
    const event = view.events.find(e => e.kind === "hold")
    assert.deepEqual([event.fromState, event.toState, event.actorKind, event.reason], ["released", "held", "staff", "staff_hold"], "the trail carries a code, not the staff text")
    assert.equal(view.status, "pending_payment", "a hold does not change the order's status")
    assert.equal((await api(`?number=${order.number}`, { jar: staff.jar })).json.data[0].held, true)
  })

  test("a repeated hold is refused with nothing written; a retry with the same key returns the first result", async () => {
    const order = await placeOrder()
    const key = `hold-${randomUUID()}`
    const first = await hold(order, { ifMatch: await etag(order), key })
    assert.equal(first.status, 200)
    const once = await counts(order.id)
    assert.deepEqual(once, { actions: 1, audits: 1, events: 1 })

    // The same request retried (a lost response): the first result, even with the old ETag.
    const retry = await hold(order, { ifMatch: 'W/"from before the hold"', key })
    assert.deepEqual([retry.status, retry.json.data.held, retry.json.data.heldAt], [200, true, first.json.data.heldAt])
    // A new request to hold a held order: refused, whoever asks.
    const again = await hold(order, { ifMatch: first.json.data.etag, jar: admin.jar })
    assert.equal(again.status, 409)
    // The same key for a different request.
    assert.equal((await hold(order, { ifMatch: first.json.data.etag, key, reason: "a different reason" })).status, 409)
    assert.equal((await release(order, { ifMatch: first.json.data.etag, key })).status, 409)
    assert.deepEqual(await counts(order.id), once, "nothing written by any repeat")
  })

  test("two staff holding at once: one succeeds, the other is refused, one record", async () => {
    const order = await placeOrder()
    const tag = await etag(order)
    const results = await Promise.all([hold(order, { ifMatch: tag, jar: admin.jar }), hold(order, { ifMatch: tag, jar: owner.jar }), hold(order, { ifMatch: tag, jar: admin.jar })])
    const statuses = results.map(r => r.status).sort()
    assert.equal(statuses.filter(s => s === 200).length, 1, String(statuses))
    assert.ok(statuses.filter(s => s !== 200).every(s => s === 412 || s === 409), String(statuses))
    assert.deepEqual(await counts(order.id), { actions: 1, audits: 1, events: 1 })
  })

  test("release: refused when not held, applied once when held, and the order can move again", async () => {
    const order = await placeOrder()
    assert.equal((await release(order, { ifMatch: await etag(order) })).status, 409, "nothing to release")
    const held = await hold(order, { ifMatch: await etag(order) })
    const res = await release(order, { ifMatch: held.json.data.etag, jar: admin.jar })
    assert.equal(res.status, 200)
    assert.deepEqual([res.json.data.held, res.json.data.heldAt, res.json.data.heldBy], [false, null, null])
    assert.equal((await release(order, { ifMatch: res.json.data.etag })).status, 409, "a second release is refused")
    const audit = await ctx.db.auditEvent.findFirstOrThrow({ where: { action: "order.released", entityId: order.id } })
    assert.deepEqual([audit.actorId, audit.reason, audit.before, audit.after], [admin.user.id, "buyer confirmed the size", { held: true }, { held: false }])
    assert.deepEqual(await counts(order.id), { actions: 2, audits: 2, events: 2 })
  })

  test("only an open order can be held", async () => {
    const order = await placeOrder()
    await force(order.id, { status: "cancelled" })
    assert.equal((await hold(order, { ifMatch: await etag(order) })).status, 409)
    assert.deepEqual(await counts(order.id), { actions: 0, audits: 0, events: 0 })
  })

  test("a held order's fulfilment cannot move forward, in the API or the database; release lifts it; cancelling stays possible", async () => {
    const order = await placeOrder()
    await force(order.id, { status: "confirmed" })
    const held = await hold(order, { ifMatch: await etag(order) })
    assert.equal(held.status, 200)

    const { transitionFulfilment, TransitionRejectedError } = await apiModule("db/transitions")
    await assert.rejects(
      ctx.db.$transaction(tx => transitionFulfilment(tx, { orderId: order.id, from: "unfulfilled", to: "packing", facts: {}, actor: { kind: "staff", id: staff.user.id }, correlationId: "test-pack" })),
      e => e instanceof TransitionRejectedError && e.reason === "order_on_hold",
    )
    await assert.rejects(force(order.id, { fulfilmentStatus: "packing" }), /on hold/, "the database refuses it whoever writes it")
    assert.equal((await ctx.db.order.findUniqueOrThrow({ where: { id: order.id } })).fulfilmentStatus, "unfulfilled")

    await release(order, { ifMatch: held.json.data.etag })
    await force(order.id, { fulfilmentStatus: "packing" })
    assert.equal((await ctx.db.order.findUniqueOrThrow({ where: { id: order.id } })).fulfilmentStatus, "packing")

    const other = await placeOrder()
    await force(other.id, { status: "confirmed" })
    assert.equal((await hold(other, { ifMatch: await etag(other) })).status, 200)
    await force(other.id, { fulfilmentStatus: "cancelled" })
    assert.equal((await ctx.db.order.findUniqueOrThrow({ where: { id: other.id } })).fulfilmentStatus, "cancelled")
  })

  test("a hold changes no money, payment or stock", async () => {
    const order = await placeOrder()
    const snapshot = async () => {
      const o = await ctx.db.order.findUniqueOrThrow({ where: { id: order.id }, include: { reservation: true, payments: true } })
      return { status: o.status, fulfilment: o.fulfilmentStatus, total: o.grandTotalPaise, hold: o.reservation?.status, payments: o.payments.length }
    }
    const before_ = await snapshot()
    const held = await hold(order, { ifMatch: await etag(order) })
    await release(order, { ifMatch: held.json.data.etag })
    assert.deepEqual(await snapshot(), before_)
  })
})

describe("CHV-S13-M13 internal notes: checked, audited without their text, never added twice", () => {
  test("a note needs an Idempotency-Key and 1 to 1000 plain characters", async () => {
    const order = await placeOrder()
    assert.equal((await note(order, { key: null })).status, 400, "no key")
    assert.equal((await note(order, { key: "short" })).status, 400, "malformed key")
    for (const text of ["", "   ", "x".repeat(1001), "bell\u0007", 42]) assert.equal((await note(order, { text })).status, 400, JSON.stringify(text))
    assert.deepEqual(await counts(order.id), { actions: 0, audits: 0, events: 0 })
  })

  test("a note is added once and audited by id and length; a retry returns the same note; a reused key is refused", async () => {
    const order = await placeOrder()
    const key = `note-${randomUUID()}`
    const text = "Buyer's alternate number noted on the call sheet"
    const first = await note(order, { key, text, jar: admin.jar })
    assert.equal(first.status, 201, JSON.stringify(first.json))
    assert.deepEqual([first.json.data.kind, first.json.data.text, first.json.data.actorId], ["note", text, admin.user.id])

    const retry = await note(order, { key, text, jar: admin.jar })
    assert.deepEqual([retry.status, retry.json.data.id], [201, first.json.data.id])
    const [a, b] = await Promise.all([note(order, { key, text, jar: admin.jar }), note(order, { key, text, jar: admin.jar })])
    assert.deepEqual([a.json.data.id, b.json.data.id], [first.json.data.id, first.json.data.id])
    assert.equal((await note(order, { key, text: "something else", jar: admin.jar })).status, 409)

    assert.deepEqual(await counts(order.id), { actions: 1, audits: 1, events: 0 })
    const audit = await ctx.db.auditEvent.findFirstOrThrow({ where: { action: "order.note_added", entityId: order.id } })
    assert.deepEqual([audit.actorId, audit.after], [admin.user.id, { noteId: first.json.data.id, length: text.length }])
    assert.ok(!JSON.stringify(audit).includes("alternate number"), "the audit trail never holds the note's text")

    // Another staff member's key is their own: the same key from the owner is a new note.
    assert.equal((await note(order, { key, text, jar: owner.jar })).status, 201)
    const view = (await api(`/${order.id}`, { jar: staff.jar })).json.data
    assert.deepEqual(view.staffActions.map(x => [x.kind, x.actorId]), [["note", admin.user.id], ["note", owner.user.id]])
    assert.equal(view.status, "pending_payment")
  })

  test("staff actions are append-only in the database", async () => {
    const order = await placeOrder()
    const res = await note(order)
    await assert.rejects(ctx.db.orderAdminAction.update({ where: { id: res.json.data.id }, data: { body: "rewritten" } }))
    await assert.rejects(ctx.db.orderAdminAction.delete({ where: { id: res.json.data.id } }))
  })
})
