// CHV-S13-M11: a payment that arrives after its stock hold expired never oversells (apps/api/src/orders/capture.ts,
// apps/api/src/db/transitions.ts). The late payment goes to staff review with an exception record; its stock is
// never re-reserved, allocated or promised, and no caller can confirm the order without stock allocated again.
// The capture racing the Stage 09 expiry job, or the 13.09 order-expiry job, ends in one consistent outcome, with
// no deadlock. Orders are placed through the web host's forwarder. Tax values are synthetic test values; delivery
// is the sandbox courier.
import { after, before, describe, test } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { apiModule, call, createStaff, Jar, newIp, setup } from "../auth/helpers.mjs"

let ctx, forward, capture, reservations, transitions, cancel, staff
let n = 0

const api = (method, path, { jar, body, headers = {} } = {}) => call(forward, `/api/cart${path}`, { method, jar, body, headers, ip: newIp() })
const address = { name: "Synthetic Buyer", phone: "+91 60000 00000", line1: "1 Example Road", line2: null, landmark: null, city: "Bengaluru", district: "Bengaluru Urban", stateCode: "IN-KA", pinCode: "560034" }
const LATER = () => new Date(Date.now() + 60 * 60 * 1000)

/** A product with `onHand` units counted. */
async function product(onHand) {
  n += 1
  const p = await ctx.db.product.create({
    data: { handle: `fixture-late-${n}`, title: `Fixture late ${n}`, status: "active", publishedAt: new Date(), shippingRestriction: "none", variants: { create: [{ sku: `fixture-late-${n}-m`, title: "M", optionKey: "size:m", pricePaise: 99900n, taxCategory: "apparel_cotton", weightGrams: 300 }] } },
    include: { variants: true },
  })
  await ctx.db.inventoryBalance.create({ data: { variantId: p.variants[0].id, onHand, lastCountedAt: new Date() } })
  return p.variants[0].id
}

/** A shopper's pending order for one unit of `variant`, its stock held, and an open Razorpay payment attempt. */
async function placed(variant) {
  const jar = new Jar()
  assert.equal((await api("POST", "/lines", { jar, body: { variantId: variant, quantity: 1 }, headers: { "idempotency-key": randomUUID() } })).status, 200)
  assert.equal((await api("PUT", "/contact", { jar, body: { email: "buyer@example.com", shippingAddress: address } })).status, 200)
  const quote = (await api("POST", "/quote", { jar, body: {} })).json.data
  const res = await api("POST", "/order", { jar, body: { quoteId: quote.id, expectedGrandTotal: quote.grandTotal }, headers: { "idempotency-key": randomUUID() } })
  assert.equal(res.status, 201, JSON.stringify(res.json))
  const order = res.json.data
  const hold = await ctx.db.inventoryReservation.findUniqueOrThrow({ where: { orderId: order.id } })
  return { order, variant, hold, attempt: await attemptFor(order) }
}
const attemptFor = order => ctx.db.paymentAttempt.create({ data: { orderId: order.id, provider: "razorpay", mode: "test", amountPaise: BigInt(order.grandTotal.amountPaise), idempotencyKey: randomUUID() } })

const event = () => ({ provider: "razorpay", eventId: `evt_${randomUUID()}`, fingerprint: `sha256:${randomUUID()}` })
const captured = (p, ev = event(), attempt = p.attempt) =>
  capture.applyCapture(ctx.db, { paymentAttemptId: attempt.id, event: ev, capturedAmountPaise: p.order.grandTotal.amountPaise, currency: "INR", providerPaymentId: `pay_${attempt.id}`, correlationId: `webhook:${ev.eventId}` })
/** What the Stage 09 expiry job does to one hold, as if its expiry time had passed. */
const expire = p => ctx.db.$transaction(tx => reservations.settleReservation(tx, p.hold.id, `worker:reservation-expiry:${p.hold.id}`, LATER()))
/** What the 13.09 order-expiry job does to one order, as if its payment window had ended. */
const windowEnds = p => ctx.db.$transaction(tx => cancel.cancelUnpaidOrder(tx, p.order.id, { reason: "payment_window_ended", actor: { kind: "system", id: null }, correlationId: `worker:order-expiry:${p.order.id}`, now: LATER() }))

const balance = async v => { const b = await ctx.db.inventoryBalance.findUniqueOrThrow({ where: { variantId: v } }); return { onHand: b.onHand, reserved: b.reserved, allocated: b.allocated } }
const moved = (holdId, type) => ctx.db.inventoryMovement.count({ where: { referenceId: holdId, type } })
const state = async p => {
  const o = await ctx.db.order.findUniqueOrThrow({ where: { id: p.order.id } })
  const h = await ctx.db.inventoryReservation.findUniqueOrThrow({ where: { id: p.hold.id } })
  const a = await ctx.db.paymentAttempt.findUniqueOrThrow({ where: { id: p.attempt.id } })
  return { order: o.status, hold: h.status, payment: a.status }
}
const exceptions = orderId => ctx.db.auditEvent.findMany({ where: { action: "payment.late_capture", entityId: orderId }, select: { actorKind: true, actorId: true, reason: true, after: true } })

before(async () => {
  ctx = await setup("chaanavya_test_s13_late_capture")
  forward = ctx.routes.me.GET
  capture = await apiModule("orders/capture")
  reservations = await apiModule("inventory/reservations")
  transitions = await apiModule("db/transitions")
  cancel = await apiModule("orders/cancel")
  staff = (await createStaff(ctx, "s13.late.owner@example.com", "OWNER")).user
  await ctx.db.taxProfile.create({ data: { sellerStateCode: "IN-KA", pricesIncludeTax: true, note: "synthetic test values", createdById: staff.id, rates: { create: [{ taxCategory: "apparel_cotton", hsnCode: "6204", rateBasisPoints: 500 }] } } })
})
after(() => ctx?.teardown())

describe("CHV-S13-M11 a capture after expiry does not oversell", () => {
  test("the last unit: A's hold expires, B buys it, then A's money arrives; A goes to review and the unit is sold once", async () => {
    const v = await product(1)
    const a = await placed(v)
    assert.equal(await expire(a), "released")
    assert.deepEqual(await balance(v), { onHand: 1, reserved: 0, allocated: 0 }, "the expired hold gave the unit back")

    const b = await placed(v)
    assert.equal((await captured(b)).outcome, "confirmed")
    assert.deepEqual(await balance(v), { onHand: 1, reserved: 0, allocated: 1 })

    assert.deepEqual(await captured(a), { outcome: "late", orderId: a.order.id })
    assert.deepEqual(await state(a), { order: "needs_review", hold: "released", payment: "captured" })
    assert.deepEqual(await balance(v), { onHand: 1, reserved: 0, allocated: 1 }, "the unit is allocated to B only: no oversell")
    assert.equal(await moved(a.hold.id, "allocation"), 0, "nothing allocated for the late payment")
    assert.equal(await moved(a.hold.id, "reservation"), 1, "and nothing re-reserved")

    const [exception] = await exceptions(a.order.id)
    assert.deepEqual(exception, { actorKind: "provider", actorId: "razorpay", reason: "hold_released", after: { paymentAttemptId: a.attempt.id, capturedAmountPaise: a.order.grandTotal.amountPaise, holdStatus: "released" } })
    const trail = (await ctx.db.orderEvent.findMany({ where: { orderId: a.order.id, kind: "status" }, orderBy: { occurredAt: "asc" } })).map(e => [e.toState, e.actorId])
    assert.deepEqual(trail.at(-1), ["needs_review", "razorpay"])
  })

  test("the late payment replayed, or reported again, changes nothing and records one exception", async () => {
    const v = await product(3)
    const p = await placed(v)
    await expire(p)
    const ev = event()
    assert.equal((await captured(p, ev)).outcome, "late")
    assert.equal((await captured(p, ev)).outcome, "duplicate")
    assert.equal((await captured(p)).outcome, "already_applied")
    assert.equal((await exceptions(p.order.id)).length, 1)
    assert.deepEqual(await balance(v), { onHand: 3, reserved: 0, allocated: 0 })
  })

  test("no one confirms a late order without stock allocated again, even by claiming it is", async () => {
    const v = await product(2)
    const p = await placed(v)
    await expire(p)
    await captured(p)
    const claim = { paymentStatus: "captured", amountMatches: true, reservationStatus: "allocated", staffApproved: true }
    await assert.rejects(
      ctx.db.$transaction(tx => transitions.transitionOrder(tx, { orderId: p.order.id, from: "needs_review", to: "confirmed", facts: claim, actor: { kind: "staff", id: staff.id }, correlationId: randomUUID() })),
      e => e instanceof transitions.TransitionRejectedError,
      "the hold row says released, whatever the caller says",
    )
    await assert.rejects(
      ctx.db.$transaction(tx => transitions.transitionOrder(tx, { orderId: p.order.id, from: "needs_review", to: "confirmed", facts: claim, actor: { kind: "provider", id: "razorpay" }, correlationId: randomUUID() })),
      e => e instanceof transitions.TransitionRejectedError,
      "and only staff resolve a review",
    )
    assert.deepEqual(await state(p), { order: "needs_review", hold: "released", payment: "captured" })
    assert.deepEqual(await balance(v), { onHand: 2, reserved: 0, allocated: 0 })
  })

  test("a second payment for an order already confirmed is an exception: nothing allocated twice", async () => {
    const v = await product(2)
    const p = await placed(v)
    assert.equal((await captured(p)).outcome, "confirmed")
    // An order has one attempt in progress at a time (Stage 14.03), so the second exists once the first ended.
    const second = await attemptFor(p.order)
    assert.equal((await captured(p, event(), second)).outcome, "exception")
    assert.equal((await ctx.db.paymentAttempt.findUniqueOrThrow({ where: { id: second.id } })).status, "captured", "the money is recorded as taken")
    assert.deepEqual(await state(p), { order: "confirmed", hold: "allocated", payment: "captured" })
    assert.deepEqual(await balance(v), { onHand: 2, reserved: 0, allocated: 1 })
    const [exception] = await exceptions(p.order.id)
    assert.deepEqual([exception.reason, exception.after.paymentAttemptId, exception.after.orderStatus], ["order_confirmed", second.id, "confirmed"])
  })
})

describe("CHV-S13-M11 a capture racing the expiry jobs ends one way, never both", () => {
  test("capture against the Stage 09 expiry job at the same moment: allocated and confirmed, or released and reviewed", async () => {
    const v = await product(8)
    const orders = []
    for (let i = 0; i < 8; i++) orders.push(await placed(v))
    const results = await Promise.all(orders.map(p => Promise.all([captured(p), expire(p)])))
    let confirmed = 0
    for (const [i, p] of orders.entries()) {
      const s = await state(p)
      const allocated = await moved(p.hold.id, "allocation")
      const released = await moved(p.hold.id, "release")
      if (s.order === "confirmed") {
        confirmed++
        assert.deepEqual([s.hold, allocated, released, results[i][0].outcome], ["allocated", 1, 0, "confirmed"])
      } else {
        assert.deepEqual([s.order, s.hold, allocated, released, results[i][0].outcome], ["needs_review", "released", 0, 1, "late"], "a paid order is never left waiting for payment")
        assert.equal((await exceptions(p.order.id)).length, 1)
      }
      assert.equal(s.payment, "captured")
    }
    assert.deepEqual(await balance(v), { onHand: 8, reserved: 0, allocated: confirmed }, "every unit is either allocated once or back on the shelf")
  })

  test("capture against the 13.09 order-expiry job at the same moment: no deadlock, and a paid order is never cancelled", async () => {
    const v = await product(8)
    const orders = []
    for (let i = 0; i < 8; i++) orders.push(await placed(v))
    const results = await Promise.allSettled(orders.flatMap(p => [captured(p), windowEnds(p)]))
    assert.deepEqual(results.filter(r => r.status === "rejected").map(r => String(r.reason)), [], "neither side fails or deadlocks")
    for (const p of orders) assert.deepEqual(await state(p), { order: "confirmed", hold: "allocated", payment: "captured" })
    assert.deepEqual(await balance(v), { onHand: 8, reserved: 0, allocated: 8 })
  })
})
