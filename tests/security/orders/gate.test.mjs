// CHV-S13-M15: the Stage 13 order and inventory gate. Concurrency, idempotency, cancellation and late-payment
// scenarios run together against one database, with orders placed through the web host's forwarder and
// payments arriving as provider captures (apps/api/src/orders/capture.ts). The gate's two promises:
//   no overselling    after every race, no stock is held or allocated twice, every balance agrees with the
//                     ledger and the holds (the Stage 09 reconciliation finds nothing), and on-hand stock always
//                     covers what is held and allocated;
//   no unpaid fulfilment  an order is packed only once paid and confirmed: an unpaid, under-review, cancelled or
//                     held order cannot move fulfilment, whoever asks, through the API or the database.
// Tax values are synthetic test values; delivery is the sandbox courier.
import { after, before, describe, test } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { apiModule, call, createStaff, Jar, newIp, setup, withOrigin } from "../auth/helpers.mjs"
import { problemsOf, reconciliationQuery } from "../../../apps/worker/src/jobs/inventory-reconciliation.ts"

let ctx, forward, capture, reservations, transitions, cancel, recovery, ledger, owner
let n = 0

const api = (method, path, { jar, body, headers = {} } = {}) => call(forward, `/api/cart${path}`, { method, jar, body, headers, ip: newIp() })
const address = { name: "Synthetic Buyer", phone: "+91 60000 00000", line1: "1 Example Road", line2: null, landmark: null, city: "Bengaluru", district: "Bengaluru Urban", stateCode: "IN-KA", pinCode: "560034" }
const LATER = () => new Date(Date.now() + 60 * 60 * 1000)
const STAFF = { kind: "staff", id: null }

/** A product with `onHand` units received through the stock ledger, so the books balance from the start. */
async function product(onHand) {
  n += 1
  const p = await ctx.db.product.create({
    data: { handle: `fixture-gate-${n}`, title: `Fixture gate ${n}`, status: "active", publishedAt: new Date(), shippingRestriction: "none", variants: { create: [{ sku: `fixture-gate-${n}-m`, title: "M", optionKey: "size:m", pricePaise: 99900n, taxCategory: "apparel_cotton", weightGrams: 300 }] } },
    include: { variants: true },
  })
  const variantId = p.variants[0].id
  await ctx.db.inventoryBalance.create({ data: { variantId, onHand: 0, lastCountedAt: new Date() } })
  await ctx.db.$transaction(tx => ledger.applyMovement(tx, { variantId, type: "receipt", quantity: onHand, reason: "gate fixture stock", reasonCode: "receipt", actor: { kind: "staff", id: owner.id }, reference: { type: "adjustment", id: randomUUID() } }))
  return variantId
}

/** A shopper with a quoted bag of `lines` ([variantId, quantity] pairs), ready to place. */
async function quoted(lines) {
  const jar = new Jar()
  for (const [variantId, quantity] of lines) assert.equal((await api("POST", "/lines", { jar, body: { variantId, quantity }, headers: { "idempotency-key": randomUUID() } })).status, 200)
  assert.equal((await api("PUT", "/contact", { jar, body: { email: "buyer@example.com", shippingAddress: address } })).status, 200)
  const quote = (await api("POST", "/quote", { jar, body: {} })).json.data
  assert.ok(quote?.id, "quoted")
  return { jar, quote }
}
const place = ({ jar, quote }) => api("POST", "/order", { jar, body: { quoteId: quote.id, expectedGrandTotal: quote.grandTotal }, headers: { "idempotency-key": randomUUID() } })

/** A placed order with its hold and, unless `pay` is false, an open Razorpay payment attempt. */
async function placed(lines, { pay = true } = {}) {
  const shopper = await quoted(lines)
  const res = await place(shopper)
  assert.equal(res.status, 201, JSON.stringify(res.json))
  if (!pay) return { ...shopper, order: res.json.data, hold: await ctx.db.inventoryReservation.findUniqueOrThrow({ where: { orderId: res.json.data.id } }), attempt: null }
  return withPayment(shopper, res.json.data)
}
async function withPayment(shopper, order) {
  const hold = await ctx.db.inventoryReservation.findUniqueOrThrow({ where: { orderId: order.id } })
  const attempt = await ctx.db.paymentAttempt.create({ data: { orderId: order.id, provider: "razorpay", mode: "test", amountPaise: BigInt(order.grandTotal.amountPaise), idempotencyKey: randomUUID() } })
  return { ...shopper, order, hold, attempt }
}

const event = () => ({ provider: "razorpay", eventId: `evt_${randomUUID()}`, fingerprint: `sha256:${randomUUID()}` })
const captured = (p, ev = event()) =>
  capture.applyCapture(ctx.db, { paymentAttemptId: p.attempt.id, event: ev, capturedAmountPaise: p.order.grandTotal.amountPaise, currency: "INR", providerPaymentId: `pay_${p.attempt.id}`, correlationId: `webhook:${ev.eventId}` })
const expire = p => ctx.db.$transaction(tx => reservations.settleReservation(tx, p.hold.id, `worker:reservation-expiry:${p.hold.id}`, LATER()))
const windowEnds = p => ctx.db.$transaction(tx => cancel.cancelUnpaidOrder(tx, p.order.id, { reason: "payment_window_ended", actor: { kind: "system", id: null }, correlationId: `worker:order-expiry:${p.order.id}`, now: LATER() }))
const shopperCancels = p => api("POST", `/order/${p.order.id}/cancel`, { jar: p.jar, body: {} })
const settle = promise => promise.then(v => v, e => e)

const state = async p => {
  const o = await ctx.db.order.findUniqueOrThrow({ where: { id: p.order.id } })
  const h = await ctx.db.inventoryReservation.findUniqueOrThrow({ where: { id: p.hold.id } })
  const a = p.attempt && (await ctx.db.paymentAttempt.findUniqueOrThrow({ where: { id: p.attempt.id } }))
  return { order: o.status, fulfilment: o.fulfilmentStatus, hold: h.status, payment: a?.status ?? null }
}
const balance = async v => { const b = await ctx.db.inventoryBalance.findUniqueOrThrow({ where: { variantId: v } }); return { onHand: b.onHand, reserved: b.reserved, allocated: b.allocated } }

/** No overselling, anywhere in the database: the books agree with themselves and stock covers every promise. */
async function assertNoOversell() {
  const rows = await reconciliationQuery(ctx.db)
  for (const row of rows) {
    assert.deepEqual(problemsOf(row), [], `variant ${row.variant_id}`)
    assert.ok(row.reserved >= 0 && row.allocated >= 0 && row.reserved + row.allocated <= row.on_hand, `variant ${row.variant_id}: ${row.reserved} held + ${row.allocated} allocated within ${row.on_hand}`)
  }
  // A confirmed order always has its stock allocated (or shipped); nothing allocated belongs to an unpaid order.
  const confirmed = await ctx.db.order.findMany({ where: { status: { in: ["confirmed", "completed"] }, quoteRef: { not: null } }, select: { id: true, reservation: { select: { status: true } }, payments: { select: { status: true } } } })
  for (const o of confirmed) {
    assert.ok(["allocated", "fulfilled"].includes(o.reservation?.status), `confirmed order ${o.id} has its stock`)
    assert.ok(o.payments.some(p => p.status === "captured"), `confirmed order ${o.id} is paid`)
  }
  const allocated = await ctx.db.inventoryReservation.findMany({ where: { status: "allocated" }, select: { order: { select: { status: true } } } })
  for (const h of allocated) assert.ok(["confirmed", "completed", "cancelled"].includes(h.order.status), `allocated stock belongs to a paid order (${h.order.status})`)
}

/** No unpaid fulfilment, anywhere: nothing past unfulfilled unless the order is confirmed or completed and paid. */
async function assertNoUnpaidFulfilment() {
  const moved = await ctx.db.order.findMany({ where: { fulfilmentStatus: { in: ["packing", "packed", "handed_over"] } }, select: { id: true, status: true, payments: { select: { status: true } } } })
  for (const o of moved) {
    assert.ok(["confirmed", "completed"].includes(o.status), `order ${o.id} in fulfilment is ${o.status}`)
    assert.ok(o.payments.some(p => p.status === "captured"), `order ${o.id} in fulfilment is paid`)
  }
}

before(async () => {
  ctx = await setup("chaanavya_test_s13_gate")
  forward = ctx.routes.me.GET
  capture = await apiModule("orders/capture")
  reservations = await apiModule("inventory/reservations")
  transitions = await apiModule("db/transitions")
  cancel = await apiModule("orders/cancel")
  recovery = await apiModule("orders/recovery")
  ledger = await apiModule("inventory/ledger")
  owner = (await createStaff(ctx, "s13.gate.owner@example.com", "OWNER")).user
  await ctx.db.taxProfile.create({ data: { sellerStateCode: "IN-KA", pricesIncludeTax: true, note: "synthetic test values", createdById: owner.id, rates: { create: [{ taxCategory: "apparel_cotton", hsnCode: "6204", rateBasisPoints: 500 }] } } })
})
after(() => ctx?.teardown())

describe("CHV-S13-M15 no overselling in tested races", () => {
  test("eight shoppers race for the last two units: two orders, each paid by replayed and concurrent captures, allocated once", async () => {
    const v = await product(2)
    const shoppers = await Promise.all(Array.from({ length: 8 }, () => quoted([[v, 1]])))
    const results = await Promise.all(shoppers.map(place))
    const won = results.map((r, i) => [r, shoppers[i]]).filter(([r]) => r.status === 201)
    assert.equal(won.length, 2, results.map(r => r.status).join(","))
    assert.ok(results.filter(r => r.status !== 201).every(r => r.status === 409), "the rest are told it sold out")
    assert.deepEqual(await balance(v), { onHand: 2, reserved: 2, allocated: 0 })

    const paid = await Promise.all(won.map(([r, s]) => withPayment(s, r.json.data)))
    // Each provider event delivered three times at once, then once more later.
    const outcomes = await Promise.all(paid.flatMap(p => { const ev = event(); return [captured(p, ev), captured(p, ev), captured(p, ev)] }))
    assert.equal(outcomes.filter(o => o.outcome === "confirmed").length, 2, JSON.stringify(outcomes))
    for (const p of paid) {
      assert.deepEqual(await state(p), { order: "confirmed", fulfilment: "unfulfilled", hold: "allocated", payment: "captured" })
      assert.equal(await ctx.db.inventoryMovement.count({ where: { referenceId: p.hold.id, type: "allocation" } }), 1, "allocated once")
    }
    assert.deepEqual(await balance(v), { onHand: 2, reserved: 0, allocated: 2 })
    await assertNoOversell()
  })

  test("multi-item bags race: a bag is held whole or not at all, and the scarce item is sold once", async () => {
    const scarce = await product(1)
    const plenty = await product(3)
    const both = await Promise.all(Array.from({ length: 4 }, () => quoted([[scarce, 1], [plenty, 1]])))
    const single = await Promise.all(Array.from({ length: 2 }, () => quoted([[plenty, 1]])))
    const results = await Promise.all([...both, ...single].map(place))
    const bothWon = results.slice(0, 4).filter(r => r.status === 201)
    assert.equal(bothWon.length, 1, results.map(r => r.status).join(","))
    assert.deepEqual(results.slice(4).map(r => r.status), [201, 201], "the single-item bags fit in the remaining stock")
    assert.deepEqual(await balance(scarce), { onHand: 1, reserved: 1, allocated: 0 })
    assert.deepEqual(await balance(plenty), { onHand: 3, reserved: 3, allocated: 0 })
    const hold = await ctx.db.inventoryReservation.findUniqueOrThrow({ where: { orderId: bothWon[0].json.data.id }, include: { lines: true } })
    assert.equal(hold.lines.length, 2, "the winning bag holds both items")
    await assertNoOversell()
  })

  test("payment, hold expiry, window end and the shopper's cancel all race on one order: one consistent outcome, ten times", async () => {
    for (let round = 0; round < 10; round++) {
      const v = await product(1)
      const p = await placed([[v, 1]])
      const ev = event()
      await Promise.all([captured(p, ev), captured(p, ev), expire(p), windowEnds(p), shopperCancels(p)].map(settle))
      const s = await state(p)
      assert.equal(s.payment, "captured", `round ${round}`)
      if (s.order === "confirmed") {
        assert.deepEqual([s.hold, await balance(v)], ["allocated", { onHand: 1, reserved: 0, allocated: 1 }], `round ${round}: paid in time`)
      } else {
        // The hold went first: the money is on record, the stock was given back, and a person decides.
        assert.ok(["needs_review", "cancelled"].includes(s.order), `round ${round}: ${s.order}`)
        assert.equal(s.hold, "released", `round ${round}`)
        assert.deepEqual(await balance(v), { onHand: 1, reserved: 0, allocated: 0 }, `round ${round}`)
        if (s.order === "cancelled") assert.ok((await ctx.db.auditEvent.count({ where: { action: "payment.late_capture", entityId: p.order.id } })) > 0, `round ${round}: a paid, cancelled order is an exception for staff`)
      }
      assert.equal(s.fulfilment, "unfulfilled")
    }
    await assertNoOversell()
    await assertNoUnpaidFulfilment()
  })

  test("a late payment after the last unit was resold: the second buyer keeps it, the first goes to review, no re-reservation", async () => {
    const v = await product(1)
    const a = await placed([[v, 1]])
    assert.equal(await expire(a), "released")
    const b = await placed([[v, 1]])
    const c = await api("POST", "/lines", { jar: new Jar(), body: { variantId: v, quantity: 1 }, headers: { "idempotency-key": randomUUID() } })
    assert.equal(c.status, 409, "sold out while B holds it")
    assert.equal((await captured(b)).outcome, "confirmed")
    assert.deepEqual(await captured(a), { outcome: "late", orderId: a.order.id })
    assert.deepEqual(await state(a), { order: "needs_review", fulfilment: "unfulfilled", hold: "released", payment: "captured" })
    assert.deepEqual(await balance(v), { onHand: 1, reserved: 0, allocated: 1 })
    // Staff cannot confirm the late order without stock: the hold speaks for itself.
    await assert.rejects(ctx.db.$transaction(tx => transitions.transitionOrder(tx, { orderId: a.order.id, from: "needs_review", to: "confirmed", facts: { staffApproved: true, paymentStatus: "captured", amountMatches: true, reservationStatus: "allocated" }, actor: STAFF, correlationId: randomUUID() })))
    assert.equal((await state(a)).order, "needs_review")
    await assertNoOversell()
  })

  test("an order with a payment still open is never cancelled or its outcome guessed; the stock goes back only once", async () => {
    const v = await product(1)
    const p = await placed([[v, 1]])
    await Promise.all([windowEnds(p), windowEnds(p), expire(p), shopperCancels(p)].map(settle))
    const s = await state(p)
    // The unknown outcome is recorded as such (13.09), never guessed as failed or paid.
    assert.deepEqual([s.order, s.payment], ["pending_payment", "pending_reconciliation"], "it waits for the payment's outcome")
    assert.deepEqual(await balance(v), { onHand: 1, reserved: s.hold === "active" ? 1 : 0, allocated: 0 })
    await assertNoOversell()
  })

  test("cancelling twice, expiring twice and re-running every job change nothing more", async () => {
    const v = await product(1)
    const p = await placed([[v, 1]], { pay: false })
    const first = await Promise.all([windowEnds(p), windowEnds(p), expire(p), shopperCancels(p)].map(settle))
    assert.ok(first.some(r => r === "cancelled" || r?.status === 200), JSON.stringify(first))
    const after1 = { state: await state(p), balance: await balance(v), movements: await ctx.db.inventoryMovement.count({ where: { referenceId: p.hold.id } }), events: await ctx.db.orderEvent.count({ where: { orderId: p.order.id } }) }
    await Promise.all([windowEnds(p), expire(p), shopperCancels(p)].map(settle))
    assert.deepEqual({ state: await state(p), balance: await balance(v), movements: await ctx.db.inventoryMovement.count({ where: { referenceId: p.hold.id } }), events: await ctx.db.orderEvent.count({ where: { orderId: p.order.id } }) }, after1)
    assert.deepEqual([after1.state.order, after1.state.hold, after1.balance], ["cancelled", "released", { onHand: 1, reserved: 0, allocated: 0 }])
    await assertNoOversell()
  })
})

describe("CHV-S13-M15 no unpaid fulfilment", () => {
  const pack = (p, actor = STAFF) => ctx.db.$transaction(tx => transitions.transitionFulfilment(tx, { orderId: p.order.id, from: "unfulfilled", to: "packing", facts: { reservationStatus: "allocated" }, actor, correlationId: randomUUID() }))
  const forcePack = p => withOrigin(ctx.db, tx => tx.order.update({ where: { id: p.order.id }, data: { fulfilmentStatus: "packing" } }))

  test("unpaid, under review and cancelled orders cannot be packed through the API or the database", async () => {
    const v = await product(5)
    const unpaid = await placed([[v, 1]])
    const review = await placed([[v, 1]])
    await withOrigin(ctx.db, tx => tx.order.update({ where: { id: review.order.id }, data: { status: "needs_review" } }))
    const cancelled = await placed([[v, 1]], { pay: false })
    assert.equal(await windowEnds(cancelled), "cancelled")
    for (const p of [unpaid, review, cancelled]) {
      await assert.rejects(pack(p))
      await assert.rejects(forcePack(p), /not confirmed|cannot move/)
      assert.equal((await state(p)).fulfilment, "unfulfilled")
    }
    // The payment provider and the courier cannot pack either, even a paid order.
    await assert.rejects(pack(unpaid, { kind: "provider", id: "razorpay" }))
    await assert.rejects(pack(unpaid, { kind: "provider", id: "shiprocket" }))
    await assertNoUnpaidFulfilment()
  })

  test("a paid order packs once its payment confirmed it; packing races apply once; a held order waits", async () => {
    const v = await product(2)
    const p = await placed([[v, 1]])
    await assert.rejects(pack(p), "not before payment")
    assert.equal((await captured(p)).outcome, "confirmed")
    const results = await Promise.all([pack(p), pack(p), pack(p)].map(settle))
    assert.ok(results.filter(r => r === "applied").length === 1 && results.every(r => r === "applied" || r === "noop" || r instanceof Error), JSON.stringify(results))
    assert.equal((await state(p)).fulfilment, "packing")
    assert.equal(await ctx.db.orderEvent.count({ where: { orderId: p.order.id, kind: "fulfilment" } }), 1)

    const held = await placed([[v, 1]])
    assert.equal((await captured(held)).outcome, "confirmed")
    await ctx.db.order.update({ where: { id: held.order.id }, data: { heldAt: new Date(), heldBy: owner.id } })
    await assert.rejects(pack(held), e => e.reason === "order_on_hold")
    await assert.rejects(forcePack(held), /on hold/)
    await assertNoUnpaidFulfilment()
    await assertNoOversell()
  })

  test("after every race above, reconciliation finds the stuck orders without changing any of them", async () => {
    const snapshot = async () => JSON.stringify(await Promise.all([
      ctx.db.order.findMany({ orderBy: { id: "asc" }, select: { id: true, status: true, fulfilmentStatus: true, updatedAt: true } }),
      ctx.db.inventoryReservation.findMany({ orderBy: { id: "asc" }, select: { id: true, status: true } }),
      ctx.db.paymentAttempt.findMany({ orderBy: { id: "asc" }, select: { id: true, status: true } }),
      ctx.db.inventoryMovement.count(),
    ]))
    const before_ = await snapshot()
    const result = await recovery.reconcileOrders(ctx.db, LATER())
    assert.equal(result.failed, 0)
    assert.equal(await snapshot(), before_)
    assert.ok((await ctx.db.orderRecoveryCase.count({ where: { status: "open" } })) > 0, "the late and unpaid orders are surfaced")
    await assertNoOversell()
    await assertNoUnpaidFulfilment()
  })
})
