// CHV-S13-M10: the captured-payment allocation bridge (apps/api/src/orders/capture.ts). An authoritative
// capture from the payment's own provider allocates the order's held stock through the Stage 09 ledger and
// confirms the order, exactly once: the same event replayed, a second event for the same capture, and many
// events at once never allocate twice. A conflicting event, another provider's event or a captured amount
// that does not match the order allocates nothing. Orders are placed through the web host's forwarder.
// Tax values are synthetic test values; delivery is the sandbox courier.
import { after, before, describe, test } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { ROOT } from "../../integration/database/helpers.mjs"
import { apiModule, call, createStaff, Jar, newIp, setup } from "../auth/helpers.mjs"

let ctx, forward, capture
let n = 0

const api = (method, path, { jar, body, headers = {} } = {}) => call(forward, `/api/cart${path}`, { method, jar, body, headers, ip: newIp() })
const address = { name: "Synthetic Buyer", phone: "+91 60000 00000", line1: "1 Example Road", line2: null, landmark: null, city: "Bengaluru", district: "Bengaluru Urban", stateCode: "IN-KA", pinCode: "560034" }

/** A pending order for two items (2 and 1), its stock held, and an open Razorpay payment attempt for it. */
async function placed() {
  const variants = []
  for (let i = 0; i < 2; i++) {
    n += 1
    const p = await ctx.db.product.create({
      data: { handle: `fixture-capture-${n}`, title: `Fixture capture ${n}`, status: "active", publishedAt: new Date(), shippingRestriction: "none", variants: { create: [{ sku: `fixture-capture-${n}-m`, title: "M", optionKey: "size:m", pricePaise: 99900n, taxCategory: "apparel_cotton", weightGrams: 300 }] } },
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
  const order = res.json.data
  const hold = await ctx.db.inventoryReservation.findUniqueOrThrow({ where: { orderId: order.id } })
  const attempt = await ctx.db.paymentAttempt.create({ data: { orderId: order.id, provider: "razorpay", mode: "test", amountPaise: BigInt(order.grandTotal.amountPaise), idempotencyKey: randomUUID() } })
  return { order, variants, hold, attempt }
}

const event = (overrides = {}) => ({ provider: "razorpay", eventId: `evt_${randomUUID()}`, fingerprint: `sha256:${randomUUID()}`, ...overrides })
const captured = (p, ev = event(), overrides = {}) => capture.applyCapture(ctx.db, { paymentAttemptId: p.attempt.id, event: ev, capturedAmountPaise: p.order.grandTotal.amountPaise, currency: "INR", providerPaymentId: `pay_${p.attempt.id}`, correlationId: `webhook:${ev.eventId}`, ...overrides })
const balances = async variants => Promise.all(variants.map(async v => { const b = await ctx.db.inventoryBalance.findUniqueOrThrow({ where: { variantId: v } }); return [b.onHand, b.reserved, b.allocated] }))
const allocations = holdId => ctx.db.inventoryMovement.findMany({ where: { referenceId: holdId, type: "allocation" }, select: { variantId: true, quantity: true, idempotencyKey: true } })
const state = async p => {
  const o = await ctx.db.order.findUniqueOrThrow({ where: { id: p.order.id } })
  const h = await ctx.db.inventoryReservation.findUniqueOrThrow({ where: { id: p.hold.id } })
  const a = await ctx.db.paymentAttempt.findUniqueOrThrow({ where: { id: p.attempt.id } })
  return { order: o.status, fulfilment: o.fulfilmentStatus, hold: h.status, payment: a.status }
}

before(async () => {
  ctx = await setup("chaanavya_test_s13_capture")
  forward = ctx.routes.me.GET
  capture = await apiModule("orders/capture")
  const { user } = await createStaff(ctx, "s13.capture.owner@example.com", "OWNER")
  await ctx.db.taxProfile.create({ data: { sellerStateCode: "IN-KA", pricesIncludeTax: true, note: "synthetic test values", createdById: user.id, rates: { create: [{ taxCategory: "apparel_cotton", hsnCode: "6204", rateBasisPoints: 500 }] } } })
})
after(() => ctx?.teardown())

describe("CHV-S13-M10 a capture allocates the held stock and confirms the order, once", () => {
  test("one capture: payment captured, stock reserved -> allocated through the Stage 09 ledger, order confirmed, nothing shipped", async () => {
    const p = await placed()
    assert.deepEqual(await balances(p.variants), [[10, 2, 0], [10, 1, 0]])
    const ev = event()
    assert.deepEqual(await captured(p, ev), { outcome: "confirmed", orderId: p.order.id })
    assert.deepEqual(await state(p), { order: "confirmed", fulfilment: "unfulfilled", hold: "allocated", payment: "captured" })
    assert.deepEqual(await balances(p.variants), [[10, 0, 2], [10, 0, 1]], "on hand unchanged, held units now allocated")
    const moved = await allocations(p.hold.id)
    assert.deepEqual(moved.map(m => [m.variantId, m.quantity, m.idempotencyKey]).sort(), p.variants.map((v, i) => [v, i === 0 ? 2 : 1, `allocation:${p.hold.id}:${v}`]).sort(), "exactly the Stage 09 allocation movements")
    const a = await ctx.db.paymentAttempt.findUniqueOrThrow({ where: { id: p.attempt.id } })
    assert.equal(Number(a.capturedAmountPaise), p.order.grandTotal.amountPaise)
    const stored = await ctx.db.providerEvent.findUniqueOrThrow({ where: { provider_eventId: { provider: "razorpay", eventId: ev.eventId } } })
    assert.deepEqual([stored.outcome, stored.type, stored.processedAt !== null], ["applied", "payment.captured", true])
    const trail = (await ctx.db.orderEvent.findMany({ where: { orderId: p.order.id }, orderBy: { occurredAt: "asc" } })).map(e => [e.kind, e.toState, e.actorId])
    assert.deepEqual(trail.slice(1), [["payment", "captured", "razorpay"], ["reservation", "allocated", null], ["status", "confirmed", "razorpay"]])
  })

  test("the same event replayed changes nothing: no second allocation, no second event", async () => {
    const p = await placed()
    const ev = event()
    await captured(p, ev)
    for (let i = 0; i < 3; i++) assert.equal((await captured(p, ev)).outcome, "duplicate")
    assert.equal((await allocations(p.hold.id)).length, 2)
    assert.deepEqual(await balances(p.variants), [[10, 0, 2], [10, 0, 1]])
    assert.equal(await ctx.db.orderEvent.count({ where: { orderId: p.order.id, kind: "status", toState: "confirmed" } }), 1)
  })

  test("a second event for the same capture (gateways send several) applies nothing new", async () => {
    const p = await placed()
    await captured(p)
    assert.equal((await captured(p, event())).outcome, "already_applied")
    assert.equal((await allocations(p.hold.id)).length, 2)
    assert.deepEqual(await balances(p.variants), [[10, 0, 2], [10, 0, 1]])
  })

  test("many events at once, replays and new ids mixed, allocate exactly once", async () => {
    const p = await placed()
    const ev = event()
    const results = await Promise.all([...Array.from({ length: 6 }, () => captured(p, ev)), ...Array.from({ length: 4 }, () => captured(p, event()))])
    assert.equal(results.filter(r => r.outcome === "confirmed").length, 1, results.map(r => r.outcome).join())
    assert.ok(results.every(r => ["confirmed", "duplicate", "already_applied"].includes(r.outcome)))
    assert.equal((await allocations(p.hold.id)).length, 2)
    assert.deepEqual(await balances(p.variants), [[10, 0, 2], [10, 0, 1]], "allocated once, never twice")
    assert.deepEqual(await state(p), { order: "confirmed", fulfilment: "unfulfilled", hold: "allocated", payment: "captured" })
  })
})

describe("CHV-S13-M10 only an authoritative, matching capture allocates", () => {
  test("the same event id with a different body is a conflict and is never applied", async () => {
    const p = await placed()
    const ev = event()
    // The provider's event was first seen with its genuine body (here, for another payment of the shop).
    await captured(await placed(), ev)
    // The same event id arrives again with a different body: never applied to anything.
    assert.equal((await captured(p, { ...ev, fingerprint: "sha256:tampered" })).outcome, "conflict")
    await assert.rejects(captured(p, event(), { capturedAmountPaise: -1 }), e => e.status === 400, "a negative amount is refused outright")
    assert.deepEqual(await state(p), { order: "pending_payment", fulfilment: "unfulfilled", hold: "active", payment: "created" })
    assert.equal((await allocations(p.hold.id)).length, 0)
  })

  test("another payment provider's event, a courier, or an unknown name allocates nothing", async () => {
    const p = await placed()
    // PhonePe is not a payment provider until the shop signs up with it (owner decision, 30 October 2026).
    await assert.rejects(captured(p, event({ provider: "phonepe" })), e => e.status === 403)
    await assert.rejects(captured(p, event({ provider: "shiprocket" })), e => e.status === 403)
    await assert.rejects(captured(p, event({ provider: "stripe" })), e => e.status === 403)
    assert.deepEqual(await state(p), { order: "pending_payment", fulfilment: "unfulfilled", hold: "active", payment: "created" })
    assert.equal(await ctx.db.providerEvent.count({ where: { summary: { path: ["paymentAttemptId"], equals: p.attempt.id } } }), 0, "a refused event is not recorded as seen")
  })

  test("a captured amount that does not match the order sends it to review; the stock stays held, neither allocated nor released", async () => {
    const p = await placed()
    const r = await captured(p, event(), { capturedAmountPaise: p.order.grandTotal.amountPaise - 100 })
    assert.equal(r.outcome, "needs_review")
    assert.deepEqual(await state(p), { order: "needs_review", fulfilment: "unfulfilled", hold: "active", payment: "captured" })
    assert.deepEqual(await balances(p.variants), [[10, 2, 0], [10, 1, 0]])
    assert.equal((await allocations(p.hold.id)).length, 0)
  })

  test("a capture after the hold was released allocates nothing and sends the order to review (13.11 decides)", async () => {
    const p = await placed()
    // The hold expires and is released (as the Stage 09 expiry job does), then the money arrives.
    const reservations = await apiModule("inventory/reservations")
    await ctx.db.$transaction(tx => reservations.transitionReservation(tx, p.hold.id, "released", { reservationExpired: true }, "hold expired", "test-late"))
    assert.equal((await captured(p)).outcome, "late")
    assert.deepEqual(await state(p), { order: "needs_review", fulfilment: "unfulfilled", hold: "released", payment: "captured" })
    assert.equal((await allocations(p.hold.id)).length, 0)
  })

  test("a failed or expired payment cannot be captured by a stray event", async () => {
    const p = await placed()
    await ctx.db.$transaction(async tx => {
      const transitions = await apiModule("db/transitions")
      await transitions.transitionPayment(tx, { paymentAttemptId: p.attempt.id, from: "created", to: "failed", facts: {}, actor: { kind: "provider", id: "razorpay" }, correlationId: "test-failed" })
    })
    assert.equal((await captured(p)).outcome, "conflict")
    assert.deepEqual(await state(p), { order: "pending_payment", fulfilment: "unfulfilled", hold: "active", payment: "failed" })
  })

  test("the bridge reuses the Stage 09 settlement and ledger: it does no stock arithmetic of its own", () => {
    const source = readFileSync(join(ROOT, "apps/api/src/orders/capture.ts"), "utf8")
    assert.match(source, /settleReservation\(tx, hold\.id, correlationId\)/)
    assert.doesNotMatch(source, /inventoryBalance|inventoryMovement|applyMovement|reserved:|allocated:/)
  })
})
