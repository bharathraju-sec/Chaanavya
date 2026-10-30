// CHV-S13-M06: order state transition rules (apps/api/src/db/transitions.ts, the contract's
// ORDER_TRANSITION_ACTORS and FULFILMENT_TRANSITION_ACTORS, migration 20261029000000_order_transitions).
// Only the moves of each state machine exist, in the API and in the database; fulfilment never starts
// for an unconfirmed order, so a pending order cannot jump to shipped (handed over to the courier);
// each move may be asked for only by its allowed actors; and the facts the order row holds come from
// the row, never from the caller.
import { after, before, describe, test } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { apiModule, setup, withOrigin } from "../auth/helpers.mjs"
import { FULFILMENT_MACHINE, FULFILMENT_STATUSES, FULFILMENT_TRANSITION_ACTORS, ORDER_MACHINE, ORDER_STATUSES, ORDER_TRANSITION_ACTORS } from "../../../packages/contracts/src/modules/state-machines.ts"

let ctx, transitions

const order = (status = "pending_payment", fulfilmentStatus = "unfulfilled") =>
  ctx.db.order.create({ data: { email: "fixture@example.com", subtotalPaise: 0n, grandTotalPaise: 0n, shippingAddress: {}, submitKey: randomUUID(), status, fulfilmentStatus } })
// A payment provider and a courier are different actors (Stage 13.07): both are recorded as kind "provider", told apart by name.
const actor = kind => (kind === "payment" ? { kind: "provider", id: "razorpay" } : kind === "courier" ? { kind: "provider", id: "shiprocket" } : { kind, id: null })
const inTx = fn => ctx.db.$transaction(tx => fn(tx))
const move = (o, from, to, kind, facts = {}) => inTx(tx => transitions.transitionOrder(tx, { orderId: o.id, from, to, facts, actor: actor(kind), correlationId: randomUUID() }))
const ship = (o, from, to, kind, facts = {}) => inTx(tx => transitions.transitionFulfilment(tx, { orderId: o.id, from, to, facts, actor: actor(kind), correlationId: randomUUID() }))
const rejected = reason => e => e.name === "Error" || e instanceof Error ? (e.reason ?? e.message).includes(reason) : false
const reload = o => ctx.db.order.findUniqueOrThrow({ where: { id: o.id } })

// Facts that satisfy each guard, so only the move and the actor decide.
const PAID = { paymentStatus: "captured", amountMatches: true, reservationStatus: "allocated" }

before(async () => {
  ctx = await setup("chaanavya_test_s13_order_transitions")
  transitions = await apiModule("db/transitions")
})
after(() => ctx?.teardown())

describe("CHV-S13-M06 an invalid jump from pending to shipped is rejected", () => {
  test("a pending order cannot be handed to the courier, packed or completed: not by the API, not by a direct write", async () => {
    const o = await order()
    await assert.rejects(ship(o, "unfulfilled", "handed_over", "courier", { hasAwb: true }), rejected("not_allowed"), "no such move")
    await assert.rejects(ship(o, "unfulfilled", "packing", "staff", { staffApproved: true, reservationStatus: "allocated" }), rejected("precondition_failed"), "packing needs a confirmed order")
    await assert.rejects(move(o, "pending_payment", "completed", "system", { allShipmentsDelivered: true, fulfilmentStatus: "handed_over" }), rejected("not_allowed"))
    await assert.rejects(ctx.db.order.update({ where: { id: o.id }, data: { fulfilmentStatus: "handed_over" } }), /cannot move from unfulfilled to handed_over/)
    await assert.rejects(ctx.db.order.update({ where: { id: o.id }, data: { fulfilmentStatus: "packing" } }), /not confirmed cannot be fulfilled/)
    await assert.rejects(ctx.db.order.update({ where: { id: o.id }, data: { status: "completed" } }), /cannot move from pending_payment to completed/)
    const after_ = await reload(o)
    assert.deepEqual([after_.status, after_.fulfilmentStatus], ["pending_payment", "unfulfilled"])
  })

  test("the full path works one step at a time, by the right actors", async () => {
    const o = await order()
    assert.equal(await move(o, "pending_payment", "confirmed", "payment", PAID), "applied")
    assert.equal(await ship(o, "unfulfilled", "packing", "staff", { reservationStatus: "allocated" }), "applied")
    assert.equal(await ship(o, "packing", "packed", "staff", { staffApproved: true }), "applied")
    assert.equal(await ship(o, "packed", "handed_over", "courier", { hasAwb: true }), "applied")
    assert.equal(await move(o, "confirmed", "completed", "system", { allShipmentsDelivered: true }), "applied")
    const done = await reload(o)
    assert.deepEqual([done.status, done.fulfilmentStatus], ["completed", "handed_over"])
    const audit = await ctx.db.auditEvent.findMany({ where: { entityId: o.id }, orderBy: { occurredAt: "asc" }, select: { action: true, actorKind: true, reason: true } })
    assert.deepEqual(audit.map(a => [a.action, a.actorKind]), [
      ["order.transition", "provider"],
      ["order.fulfilment_transition", "staff"],
      ["order.fulfilment_transition", "staff"],
      ["order.fulfilment_transition", "provider"],
      ["order.transition", "system"],
    ])
    assert.ok(audit.every(a => a.reason.length > 0), "every move records the rule it met")
  })

  test("an order is completed only after it was handed over", async () => {
    const o = await order("confirmed")
    await assert.rejects(ctx.db.order.update({ where: { id: o.id }, data: { status: "completed" } }), /only after it was handed over/)
    await assert.rejects(move(o, "confirmed", "completed", "system", { allShipmentsDelivered: true }), rejected("precondition_failed"), "the row's own fulfilment status is the fact")
  })
})

describe("CHV-S13-M06 the database allows exactly the machines' moves", () => {
  test("every order status pair: allowed if and only if it is a transition of ORDER_MACHINE", async () => {
    const allowed = new Set(ORDER_MACHINE.transitions.map(t => `${t.from}->${t.to}`))
    for (const from of ORDER_STATUSES) {
      for (const to of ORDER_STATUSES) {
        if (from === to) continue
        // Completion needs a handed-over order; give the row that so only the move itself is tested.
        const o = await order(from, to === "completed" ? "handed_over" : "unfulfilled")
        const ok = await withOrigin(ctx.db, tx => tx.order.update({ where: { id: o.id }, data: { status: to } })).then(() => true, () => false)
        assert.equal(ok, allowed.has(`${from}->${to}`), `${from} -> ${to}`)
      }
    }
  })

  test("every fulfilment pair on a confirmed order: allowed if and only if it is a transition of FULFILMENT_MACHINE", async () => {
    const allowed = new Set(FULFILMENT_MACHINE.transitions.map(t => `${t.from}->${t.to}`))
    for (const from of FULFILMENT_STATUSES) {
      for (const to of FULFILMENT_STATUSES) {
        if (from === to) continue
        const o = await order("confirmed", from)
        const ok = await withOrigin(ctx.db, tx => tx.order.update({ where: { id: o.id }, data: { fulfilmentStatus: to } })).then(() => true, () => false)
        assert.equal(ok, allowed.has(`${from}->${to}`), `${from} -> ${to}`)
      }
    }
  })

  test("every transition has its actors listed, and every listed move is a transition", () => {
    for (const [machine, actors] of [[ORDER_MACHINE, ORDER_TRANSITION_ACTORS], [FULFILMENT_MACHINE, FULFILMENT_TRANSITION_ACTORS]]) {
      const moves = machine.transitions.map(t => `${t.from}->${t.to}`).sort()
      assert.deepEqual(Object.keys(actors).sort(), moves, machine.name)
      for (const list of Object.values(actors)) assert.ok(list.length > 0)
    }
  })
})

describe("CHV-S13-M06 only the allowed actors may ask for a move", () => {
  test("a customer, a guest or staff cannot confirm a payment; only the provider or a system job can", async () => {
    for (const kind of ["customer", "guest", "staff"]) {
      const o = await order()
      await assert.rejects(move(o, "pending_payment", "confirmed", kind, { ...PAID, source: "provider" }), rejected("actor_not_allowed"), `${kind}, even claiming to be the provider`)
      assert.equal((await reload(o)).status, "pending_payment")
    }
    assert.equal(await move(await order(), "pending_payment", "confirmed", "system", PAID), "applied")
  })

  test("only staff resolve a review; a system job cannot", async () => {
    const o = await order("needs_review")
    await assert.rejects(move(o, "needs_review", "confirmed", "system", { ...PAID, staffApproved: true, source: "staff" }), rejected("actor_not_allowed"))
    assert.equal(await move(o, "needs_review", "confirmed", "staff", { ...PAID, staffApproved: true }), "applied")
  })

  test("a paid order is cancelled by staff only, before dispatch; the buyer and a system job may not", async () => {
    const o = await order("confirmed")
    for (const actor of ["customer", "guest", "system"]) await assert.rejects(move(o, "confirmed", "cancelled", actor, { refundRequested: true }), rejected("actor_not_allowed"), actor)
    assert.equal(await move(o, "confirmed", "cancelled", "staff", { refundRequested: true, staffApproved: true }), "applied")
    const unapproved = await order("confirmed")
    await assert.rejects(move(unapproved, "confirmed", "cancelled", "staff", { refundRequested: true }), rejected("precondition_failed"), "staff must approve it")
    const packed = await order("confirmed", "packed")
    assert.equal(await move(packed, "confirmed", "cancelled", "staff", { refundRequested: true, staffApproved: true }), "applied", "packed is still before dispatch")
    const shipped = await order("confirmed", "handed_over")
    await assert.rejects(move(shipped, "confirmed", "cancelled", "staff", { refundRequested: true, staffApproved: true, fulfilmentStatus: "packed" }), rejected("precondition_failed"), "after handover only returns apply; the row's fulfilment status wins over the caller's")
  })

  test("only the courier hands a parcel over; staff pack it", async () => {
    const o = await order("confirmed", "packed")
    for (const kind of ["staff", "system", "customer"]) await assert.rejects(ship(o, "packed", "handed_over", kind, { hasAwb: true }), rejected("actor_not_allowed"), kind)
    await assert.rejects(ship(await order("confirmed", "packing"), "packing", "packed", "courier", { staffApproved: true }), rejected("actor_not_allowed"))
    assert.equal(await ship(o, "packed", "handed_over", "courier", { hasAwb: true }), "applied")
  })

  test("facts the order row holds cannot be supplied by the caller", async () => {
    const pending = await order()
    await assert.rejects(ship(pending, "unfulfilled", "packing", "staff", { orderStatus: "confirmed", reservationStatus: "allocated" }), rejected("precondition_failed"), "claiming the order is confirmed changes nothing")
    assert.equal((await reload(pending)).fulfilmentStatus, "unfulfilled")
  })
})

describe("CHV-S13-M06 moves are compare-and-set and repeat safely", () => {
  test("asking for the state it is already in is a no-op; a stale 'from' is refused", async () => {
    const o = await order("confirmed")
    const audits = () => ctx.db.auditEvent.count({ where: { entityId: o.id } })
    const before_ = await audits()
    assert.equal(await move(o, "pending_payment", "confirmed", "payment", PAID), "noop")
    assert.equal(await audits(), before_, "a repeat writes nothing")
    await assert.rejects(move(o, "needs_review", "cancelled", "staff", { staffApproved: true, refundRequested: true }), e => e.constructor.name === "ConcurrentUpdateError")
  })

  test("two simultaneous moves from the same state: exactly one applies", async () => {
    const o = await order()
    const results = await Promise.allSettled([
      move(o, "pending_payment", "confirmed", "payment", PAID),
      move(o, "pending_payment", "cancelled", "system", { paymentStatus: "failed", reservationStatus: "released" }),
    ])
    assert.equal(results.filter(r => r.status === "fulfilled" && r.value === "applied").length, 1)
    assert.ok(["confirmed", "cancelled"].includes((await reload(o)).status))
  })
})
