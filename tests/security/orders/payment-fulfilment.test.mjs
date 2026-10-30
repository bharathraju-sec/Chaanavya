// CHV-S13-M07: financial and fulfilment state are separate (apps/api/src/db/transitions.ts,
// PAYMENT_TRANSITION_ACTORS and actorClassOf in the contract, migration
// 20261029010000_payment_transitions). A payment attempt moves on its own payment provider's events;
// the order's financial status follows the payment; packing and shipping are separate moves by staff
// and the courier. A payment callback, however complete, never marks an order shipped: a payment
// provider may not move fulfilment, the database refuses a status and fulfilment change in one write,
// and a courier may not touch a payment.
import { after, before, describe, test } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { apiModule, setup, withOrigin } from "../auth/helpers.mjs"
import { actorClassOf, PAYMENT_MACHINE, PAYMENT_STATUSES, PAYMENT_TRANSITION_ACTORS } from "../../../packages/contracts/src/modules/state-machines.ts"

let ctx, transitions

const RAZORPAY = { kind: "provider", id: "razorpay" }
const PHONEPE = { kind: "provider", id: "phonepe" }
const COURIER = { kind: "provider", id: "shiprocket" }
const STAFF = { kind: "staff", id: null }
const SYSTEM = { kind: "system", id: null }

async function order(status = "pending_payment", fulfilmentStatus = "unfulfilled") {
  return ctx.db.order.create({ data: { email: "fixture@example.com", subtotalPaise: 189900n, grandTotalPaise: 189900n, shippingAddress: {}, submitKey: randomUUID(), status, fulfilmentStatus } })
}
const attempt = (o, status = "created", provider = "razorpay") =>
  ctx.db.paymentAttempt.create({ data: { orderId: o.id, provider, mode: "test", amountPaise: 189900n, idempotencyKey: randomUUID(), status } })
const inTx = fn => ctx.db.$transaction(tx => fn(tx))
const pay = (a, from, to, actor, facts = {}) => inTx(tx => transitions.transitionPayment(tx, { paymentAttemptId: a.id, from, to, facts, actor, correlationId: randomUUID() }))
const move = (o, from, to, actor, facts = {}) => inTx(tx => transitions.transitionOrder(tx, { orderId: o.id, from, to, facts, actor, correlationId: randomUUID() }))
const ship = (o, from, to, actor, facts = {}) => inTx(tx => transitions.transitionFulfilment(tx, { orderId: o.id, from, to, facts, actor, correlationId: randomUUID() }))
const refused = reason => e => (e.reason ?? e.message ?? "").includes(reason)
const reload = o => ctx.db.order.findUniqueOrThrow({ where: { id: o.id } })

before(async () => {
  ctx = await setup("chaanavya_test_s13_payment_fulfilment")
  transitions = await apiModule("db/transitions")
})
after(() => ctx?.teardown())

describe("CHV-S13-M07 shipped state cannot be inferred from a payment callback alone", () => {
  test("a complete payment callback captures the payment and confirms the order; fulfilment does not move", async () => {
    const o = await order()
    const a = await attempt(o)
    assert.equal(await pay(a, "created", "captured", RAZORPAY), "applied")
    assert.equal(await move(o, "pending_payment", "confirmed", RAZORPAY, { paymentStatus: "captured", amountMatches: true, reservationStatus: "allocated" }), "applied")
    const after_ = await reload(o)
    assert.deepEqual([after_.status, after_.fulfilmentStatus], ["confirmed", "unfulfilled"], "paid is not packed, and certainly not shipped")
    assert.equal((await ctx.db.paymentAttempt.findUniqueOrThrow({ where: { id: a.id } })).status, "captured")
  })

  test("the payment provider cannot pack, hand over or complete an order, whatever it claims", async () => {
    const packed = await order("confirmed", "packed")
    await assert.rejects(ship(packed, "packed", "handed_over", RAZORPAY, { hasAwb: true }), refused("actor_not_allowed"), "a payment callback is not a courier scan")
    await assert.rejects(ship(await order("confirmed"), "unfulfilled", "packing", RAZORPAY, { reservationStatus: "allocated" }), refused("actor_not_allowed"))
    const handed = await order("confirmed", "handed_over")
    await assert.rejects(move(handed, "confirmed", "completed", RAZORPAY, { allShipmentsDelivered: true }), refused("actor_not_allowed"))
    assert.equal((await reload(packed)).fulfilmentStatus, "packed")
  })

  test("one write cannot both confirm an order and move its fulfilment", async () => {
    const o = await order()
    await assert.rejects(ctx.db.order.update({ where: { id: o.id }, data: { status: "confirmed", fulfilmentStatus: "packing" } }), /separate steps/)
    const confirmed = await order("confirmed")
    await assert.rejects(ctx.db.order.update({ where: { id: confirmed.id }, data: { status: "cancelled", fulfilmentStatus: "cancelled" } }), /separate steps/)
    assert.deepEqual([(await reload(o)).status, (await reload(o)).fulfilmentStatus], ["pending_payment", "unfulfilled"])
  })

  test("shipping happens only through its own steps, after payment, by staff and the courier", async () => {
    const o = await order()
    const a = await attempt(o)
    await pay(a, "created", "captured", RAZORPAY)
    await move(o, "pending_payment", "confirmed", RAZORPAY, { paymentStatus: "captured", amountMatches: true, reservationStatus: "allocated" })
    await ship(o, "unfulfilled", "packing", STAFF, { reservationStatus: "allocated" })
    await ship(o, "packing", "packed", STAFF, { staffApproved: true })
    assert.equal(await ship(o, "packed", "handed_over", COURIER, { hasAwb: true }), "applied")
    const done = await reload(o)
    assert.deepEqual([done.status, done.fulfilmentStatus], ["confirmed", "handed_over"])
    const actors = await ctx.db.auditEvent.findMany({ where: { OR: [{ entityId: o.id }, { entityId: a.id }] }, orderBy: { occurredAt: "asc" }, select: { action: true, actorId: true } })
    assert.deepEqual(actors.map(e => [e.action, e.actorId]), [
      ["payment.transition", "razorpay"],
      ["order.transition", "razorpay"],
      ["order.fulfilment_transition", null],
      ["order.fulfilment_transition", null],
      ["order.fulfilment_transition", "shiprocket"],
    ])
  })
})

describe("CHV-S13-M07 payments move on their own provider's events only", () => {
  test("a courier, staff or a customer cannot capture a payment; a system job only where the machine allows", async () => {
    for (const actor of [COURIER, STAFF, { kind: "customer", id: null }]) {
      const a = await attempt(await order())
      await assert.rejects(pay(a, "created", "captured", actor), refused("actor_not_allowed"), JSON.stringify(actor))
    }
    const a = await attempt(await order())
    await assert.rejects(pay(a, "created", "captured", SYSTEM), refused("actor_not_allowed"))
    assert.equal(await pay(a, "created", "pending_reconciliation", SYSTEM), "applied", "an unknown outcome is the one thing a job records")
  })

  test("a provider not on the launch list moves nothing (PhonePe until the shop signs up); an unknown provider moves nothing", async () => {
    const a = await attempt(await order(), "created", "razorpay")
    await assert.rejects(pay(a, "created", "captured", PHONEPE), refused("actor_not_allowed"))
    await assert.rejects(pay(a, "created", "captured", { kind: "provider", id: "unknown-gateway" }), refused("actor_not_allowed"))
    await assert.rejects(pay(a, "created", "captured", { kind: "provider", id: null }), refused("actor_not_allowed"))
    assert.equal((await ctx.db.paymentAttempt.findUniqueOrThrow({ where: { id: a.id } })).status, "created")
  })

  test("a courier cannot confirm payment for an order", async () => {
    const o = await order()
    await assert.rejects(move(o, "pending_payment", "confirmed", COURIER, { paymentStatus: "captured", amountMatches: true, reservationStatus: "allocated" }), refused("actor_not_allowed"))
    assert.equal((await reload(o)).status, "pending_payment")
  })

  test("the database allows exactly the payment machine's moves, and the actor table covers each of them", async () => {
    const allowed = new Set(PAYMENT_MACHINE.transitions.map(t => `${t.from}->${t.to}`))
    assert.deepEqual(Object.keys(PAYMENT_TRANSITION_ACTORS).sort(), [...allowed].sort())
    const o = await order()
    for (const from of PAYMENT_STATUSES) {
      for (const to of PAYMENT_STATUSES) {
        if (from === to) continue
        const a = await attempt(o, from)
        const ok = await withOrigin(ctx.db, tx => tx.paymentAttempt.update({ where: { id: a.id }, data: { status: to } })).then(() => true, () => false)
        assert.equal(ok, allowed.has(`${from}->${to}`), `${from} -> ${to}`)
      }
    }
  })

  test("repeats are harmless: the same callback twice changes nothing more", async () => {
    const a = await attempt(await order())
    assert.equal(await pay(a, "created", "captured", RAZORPAY), "applied")
    assert.equal(await pay(a, "created", "captured", RAZORPAY), "noop")
    assert.equal(await ctx.db.auditEvent.count({ where: { entityId: a.id } }), 1)
  })

  test("actors are classed by kind and provider name", () => {
    assert.equal(actorClassOf(RAZORPAY), "payment_provider")
    assert.equal(actorClassOf(PHONEPE), null, "not a payment provider until it is added to the list")
    assert.equal(actorClassOf(COURIER), "courier")
    assert.equal(actorClassOf({ kind: "provider", id: "sandbox" }), "courier")
    assert.equal(actorClassOf({ kind: "provider", id: "stripe" }), null)
    assert.equal(actorClassOf({ kind: "guest", id: null }), "guest")
    assert.equal(actorClassOf({ kind: "robot", id: null }), null)
  })
})
