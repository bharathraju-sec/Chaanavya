// CHV-S13-M09: safe cancellation of an unpaid order (apps/api/src/orders/cancel.ts, POST
// /api/cart/order/:orderId/cancel, the worker's order-expiry job). An unpaid order is cancelled when its
// payment window ends or when its shopper cancels, and its stock hold is released once: a retried job, a
// repeated click, many parallel cancels, and a job racing the shopper all release the stock exactly once.
// An order whose payment is still in flight is left pending with its stock held until the payment's
// outcome is known. Calls go through the web host's forwarder. Tax values are synthetic test values;
// delivery is the sandbox courier.
import { after, before, describe, test } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { apiModule, call, createStaff, Jar, newIp, setup, withOrigin } from "../auth/helpers.mjs"
import { orderExpiryJob } from "../../../apps/worker/src/jobs/order-expiry.ts"

let ctx, forward, cancel
let n = 0

const api = (method, path, { jar, body, headers = {} } = {}) => call(forward, `/api/cart${path}`, { method, jar, body, headers, ip: newIp() })
const address = { name: "Synthetic Buyer", phone: "+91 60000 00000", line1: "1 Example Road", line2: null, landmark: null, city: "Bengaluru", district: "Bengaluru Urban", stateCode: "IN-KA", pinCode: "560034" }

/** A guest's pending order for two items (quantities 2 and 1), with its stock held. */
async function placed() {
  const variants = []
  for (let i = 0; i < 2; i++) {
    n += 1
    const p = await ctx.db.product.create({
      data: { handle: `fixture-cancel-${n}`, title: `Fixture cancel ${n}`, status: "active", publishedAt: new Date(), shippingRestriction: "none", variants: { create: [{ sku: `fixture-cancel-${n}-m`, title: "M", optionKey: "size:m", pricePaise: 99900n, taxCategory: "apparel_cotton", weightGrams: 300 }] } },
      include: { variants: true },
    })
    await ctx.db.inventoryBalance.create({ data: { variantId: p.variants[0].id, onHand: 10, lastCountedAt: new Date() } })
    variants.push(p.variants[0].id)
  }
  const jar = new Jar()
  for (const [v, q] of [[variants[0], 2], [variants[1], 1]]) assert.equal((await api("POST", "/lines", { jar, body: { variantId: v, quantity: q }, headers: { "idempotency-key": randomUUID() } })).status, 200)
  assert.equal((await api("PUT", "/contact", { jar, body: { email: "buyer@example.com", shippingAddress: address } })).status, 200)
  const quote = (await api("POST", "/quote", { jar, body: {} })).json.data
  const res = await api("POST", "/order", { jar, body: { quoteId: quote.id, expectedGrandTotal: quote.grandTotal }, headers: { "idempotency-key": randomUUID() } })
  assert.equal(res.status, 201, JSON.stringify(res.json))
  const hold = await ctx.db.inventoryReservation.findUniqueOrThrow({ where: { orderId: res.json.data.id } })
  return { jar, order: res.json.data, variants, hold }
}

const shopperCancel = (jar, orderId) => api("POST", `/order/${orderId}/cancel`, { jar, body: {} })
const reserved = async variants => Promise.all(variants.map(async v => (await ctx.db.inventoryBalance.findUniqueOrThrow({ where: { variantId: v } })).reserved))
const releases = holdId => ctx.db.inventoryMovement.count({ where: { referenceId: holdId, type: "release" } })
const statusOf = async id => (await ctx.db.order.findUniqueOrThrow({ where: { id } })).status
const holdStatus = async id => (await ctx.db.inventoryReservation.findUniqueOrThrow({ where: { id } })).status
const cancelledEvents = id => ctx.db.orderEvent.count({ where: { orderId: id, kind: "status", toState: "cancelled" } })
const afterWindow = order => new Date(new Date(order.payableUntil).getTime() + 1000)
const expire = (order, now = afterWindow(order)) => ctx.db.$transaction(tx => cancel.cancelUnpaidOrder(tx, order.id, { reason: "payment_window_ended", actor: { kind: "system", id: null }, correlationId: `test-expiry-${randomUUID()}`, now }))
const attempt = (orderId, status) => ctx.db.paymentAttempt.create({ data: { orderId, provider: "razorpay", mode: "test", amountPaise: 1n, idempotencyKey: randomUUID(), status } })

before(async () => {
  ctx = await setup("chaanavya_test_s13_cancel")
  forward = ctx.routes.me.GET
  cancel = await apiModule("orders/cancel")
  const { user } = await createStaff(ctx, "s13.cancel.owner@example.com", "OWNER")
  await ctx.db.taxProfile.create({ data: { sellerStateCode: "IN-KA", pricesIncludeTax: true, note: "synthetic test values", createdById: user.id, rates: { create: [{ taxCategory: "apparel_cotton", hsnCode: "6204", rateBasisPoints: 500 }] } } })
})
after(() => ctx?.teardown())

describe("CHV-S13-M09 a retry or race cannot double-release stock", () => {
  test("the shopper cancels: the hold is released once, the order cancelled once, each with its origin", async () => {
    const { jar, order, variants, hold } = await placed()
    assert.deepEqual(await reserved(variants), [2, 1])
    const res = await shopperCancel(jar, order.id)
    assert.equal(res.status, 200, JSON.stringify(res.json))
    assert.deepEqual([res.json.outcome, res.json.data.status], ["cancelled", "cancelled"])
    assert.deepEqual(await reserved(variants), [0, 0], "the stock is free again")
    assert.equal(await releases(hold.id), 2, "one release movement per line")
    assert.equal(await holdStatus(hold.id), "released")
    const trail = (await ctx.db.orderEvent.findMany({ where: { orderId: order.id }, orderBy: { occurredAt: "asc" } })).map(e => [e.kind, e.toState, e.actorKind])
    assert.deepEqual(trail, [["placed", "pending_payment", "guest"], ["reservation", "released", "system"], ["status", "cancelled", "guest"]])
  })

  test("a repeated cancel changes nothing: no second release, no second event", async () => {
    const { jar, order, variants, hold } = await placed()
    await shopperCancel(jar, order.id)
    for (let i = 0; i < 3; i++) {
      const again = await shopperCancel(jar, order.id)
      assert.deepEqual([again.status, again.json.outcome], [200, "noop"])
    }
    assert.deepEqual(await reserved(variants), [0, 0])
    assert.equal(await releases(hold.id), 2)
    assert.equal(await cancelledEvents(order.id), 1)
  })

  test("eight parallel cancels by the shopper release the stock exactly once", async () => {
    const { jar, order, variants, hold } = await placed()
    const results = await Promise.all(Array.from({ length: 8 }, () => shopperCancel(jar, order.id)))
    assert.ok(results.every(r => r.status === 200), results.map(r => `${r.status} ${JSON.stringify(r.json?.error ?? "")}`).join(" | "))
    assert.equal(results.filter(r => r.json.outcome === "cancelled").length, 1)
    assert.deepEqual(await reserved(variants), [0, 0])
    assert.equal(await releases(hold.id), 2)
    assert.equal(await cancelledEvents(order.id), 1)
  })

  test("the expiry job racing the shopper, and overlapping job runs, still release once", async () => {
    const { jar, order, variants, hold } = await placed()
    const job = orderExpiryJob(ctx.db, cancel.cancelUnpaidOrder)
    // The window is over for the job; the shopper presses cancel at the same moment, twice.
    const late = afterWindow(order)
    const results = await Promise.allSettled([expire(order, late), expire(order, late), shopperCancel(jar, order.id), shopperCancel(jar, order.id)])
    assert.ok(results.every(r => r.status === "fulfilled"), JSON.stringify(results.filter(r => r.status === "rejected").map(r => String(r.reason))))
    assert.deepEqual(await reserved(variants), [0, 0])
    assert.equal(await releases(hold.id), 2, "exactly one release movement per line")
    assert.equal(await cancelledEvents(order.id), 1)
    // Runs of the real job afterwards find nothing to do.
    const runs = await Promise.all([job.run(), job.run()])
    assert.ok(runs.every(r => r.cancelled === 0 && r.failed === 0))
    assert.equal(await releases(hold.id), 2)
  })

  test("the expiry job cancels orders whose window has ended, and only those, once across overlapping runs", async () => {
    const due = await placed()
    const fifteenMinutesOn = afterWindow(due.order)
    const job = orderExpiryJob(ctx.db, cancel.cancelUnpaidOrder, { clock: () => fifteenMinutesOn })
    const runs = await Promise.all([job.run(), job.run(), job.run()])
    assert.equal(runs.reduce((a, r) => a + r.failed, 0), 0)
    assert.equal(await statusOf(due.order.id), "cancelled")
    assert.deepEqual(await reserved(due.variants), [0, 0])
    assert.equal(await releases(due.hold.id), 2, "overlapping runs released once")
    assert.equal(await cancelledEvents(due.order.id), 1)
    const event = await ctx.db.orderEvent.findFirstOrThrow({ where: { orderId: due.order.id, kind: "status" } })
    assert.deepEqual([event.actorKind, event.correlationId], ["system", `worker:order-expiry:${due.order.id}`])
    // An order still inside its window is left alone by the job and by an expiry call.
    const notDue = await placed()
    const now = await orderExpiryJob(ctx.db, cancel.cancelUnpaidOrder).run()
    assert.equal(now.failed, 0)
    assert.equal(await expire(notDue.order, new Date()), "noop")
    assert.deepEqual([await statusOf(notDue.order.id), ...(await reserved(notDue.variants))], ["pending_payment", 2, 1])
  })
})

describe("CHV-S13-M09 a payment in flight is never cut off", () => {
  test("an open (created) payment past the window is sent for reconciliation; the order and its stock wait", async () => {
    const { order, variants, hold } = await placed()
    const a = await attempt(order.id, "created")
    assert.equal(await expire(order), "awaiting_payment_outcome")
    assert.equal((await ctx.db.paymentAttempt.findUniqueOrThrow({ where: { id: a.id } })).status, "pending_reconciliation", "the gateway will be asked (13.14)")
    assert.deepEqual([await statusOf(order.id), await holdStatus(hold.id)], ["pending_payment", "active"])
    assert.deepEqual(await reserved(variants), [2, 1], "stock stays held while the outcome is unknown")
    assert.equal(await expire(order), "awaiting_payment_outcome", "and again on the next run")
  })

  test("an authorized or reconciling payment keeps the order; the shopper cannot cancel it away either", async () => {
    for (const status of ["authorized", "pending_reconciliation"]) {
      const { jar, order, variants, hold } = await placed()
      await attempt(order.id, status)
      assert.equal(await expire(order), "awaiting_payment_outcome")
      const res = await shopperCancel(jar, order.id)
      assert.deepEqual([res.status, res.json.outcome], [200, "awaiting_payment_outcome"])
      assert.deepEqual([await statusOf(order.id), await holdStatus(hold.id), await releases(hold.id)], ["pending_payment", "active", 0])
      assert.deepEqual(await reserved(variants), [2, 1])
    }
  })

  test("a failed or expired payment no longer holds the order back", async () => {
    for (const status of ["failed", "expired"]) {
      const { jar, order, variants } = await placed()
      await attempt(order.id, status)
      assert.equal((await shopperCancel(jar, order.id)).json.outcome, "cancelled")
      assert.deepEqual(await reserved(variants), [0, 0])
    }
  })

  test("a captured payment is never cancelled here", async () => {
    const { jar, order, hold } = await placed()
    await attempt(order.id, "captured")
    assert.equal(await expire(order), "noop")
    assert.equal((await shopperCancel(jar, order.id)).json.outcome, "noop")
    assert.deepEqual([await statusOf(order.id), await holdStatus(hold.id)], ["pending_payment", "active"])
  })
})

describe("CHV-S13-M09 only the shopper's own unpaid order", () => {
  test("another shopper, an unknown id or a malformed id gets 404 and nothing is released", async () => {
    const { order, variants } = await placed()
    const stranger = (await placed()).jar
    assert.equal((await shopperCancel(stranger, order.id)).status, 404)
    assert.equal((await shopperCancel(stranger, randomUUID())).status, 404)
    assert.equal((await shopperCancel(stranger, "nope")).status, 404)
    assert.equal((await shopperCancel(new Jar(), order.id)).status, 404)
    assert.deepEqual(await reserved(variants), [2, 1])
  })

  test("a confirmed order cannot be cancelled through this route", async () => {
    const { jar, order } = await placed()
    await withOrigin(ctx.db, tx => tx.order.update({ where: { id: order.id }, data: { status: "confirmed" } }))
    const res = await shopperCancel(jar, order.id)
    assert.deepEqual([res.status, res.json.error.fields.order], [409, "confirmed"])
  })

  test("the route is closed in production", async () => {
    const { jar, order } = await placed()
    const before_ = process.env.APP_ENV
    process.env.APP_ENV = "production"
    try {
      assert.equal((await shopperCancel(jar, order.id)).status, 404)
    } finally {
      process.env.APP_ENV = before_
    }
    assert.equal(await statusOf(order.id), "pending_payment")
  })
})
