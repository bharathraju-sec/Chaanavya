// CHV-S02-001: every order, payment, reservation, fulfilment, shipment, return and refund
// transition has a declared precondition, and the key commerce invariants hold.
import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { FULFILMENT_MACHINE, ORDER_MACHINE, PAYMENT_MACHINE, RESERVATION_MACHINE, SHIPMENT_MACHINE, STATE_MACHINES, planTransition } from "../../packages/contracts/src/modules/state-machines.ts"

describe("CHV-S02-001 every transition declares a precondition", () => {
  for (const machine of STATE_MACHINES) {
    test(`${machine.name}: transitions are well formed`, () => {
      assert.ok(machine.states.includes(machine.initial), "initial state is a known state")
      for (const state of machine.terminal) assert.ok(machine.states.includes(state), `terminal ${state} is a known state`)

      const pairs = new Set()
      for (const t of machine.transitions) {
        const label = `${machine.name} ${t.from} -> ${t.to}`
        assert.ok(machine.states.includes(t.from) && machine.states.includes(t.to), `${label}: known states`)
        assert.notEqual(t.from, t.to, `${label}: no self transitions (replays are no-ops)`)
        assert.match(t.precondition, /^[a-z0-9_]+$/, `${label}: precondition id`)
        assert.ok(t.description.trim().length > 10, `${label}: precondition description`)
        assert.equal(typeof t.guard, "function", `${label}: guard`)
        assert.equal(t.guard({}), false, `${label}: guard fails closed with no facts`)
        assert.ok(!machine.terminal.includes(t.from), `${label}: terminal states have no exits`)
        assert.ok(!pairs.has(`${t.from}>${t.to}`), `${label}: declared once`)
        pairs.add(`${t.from}>${t.to}`)
      }
    })

    test(`${machine.name}: every state is reachable and every non-terminal state has an exit`, () => {
      const reachable = new Set([machine.initial])
      let grew = true
      while (grew) {
        grew = false
        for (const t of machine.transitions) {
          if (reachable.has(t.from) && !reachable.has(t.to)) {
            reachable.add(t.to)
            grew = true
          }
        }
      }
      for (const state of machine.states) {
        assert.ok(reachable.has(state), `${machine.name}: ${state} reachable from ${machine.initial}`)
        if (!machine.terminal.includes(state)) assert.ok(machine.transitions.some(t => t.from === state), `${machine.name}: ${state} has an exit`)
      }
    })
  }

  test("illegal and unknown transitions are rejected, replays are no-ops", () => {
    assert.deepEqual(planTransition(ORDER_MACHINE, "pending_payment", "completed", {}), { kind: "rejected", reason: "not_allowed" })
    assert.deepEqual(planTransition(ORDER_MACHINE, "pending_payment", "shipped", {}), { kind: "rejected", reason: "unknown_state" })
    assert.deepEqual(planTransition(ORDER_MACHINE, "confirmed", "confirmed", {}), { kind: "noop" })
    assert.deepEqual(planTransition(ORDER_MACHINE, "cancelled", "confirmed", { paymentStatus: "captured", amountMatches: true, reservationStatus: "allocated" }), {
      kind: "rejected",
      reason: "not_allowed",
    })
  })
})

describe("commerce invariants encoded as guards", () => {
  test("verified payment before confirmation", () => {
    const allocated = { reservationStatus: "allocated", amountMatches: true }
    assert.equal(planTransition(ORDER_MACHINE, "pending_payment", "confirmed", { ...allocated, paymentStatus: "authorized" }).kind, "rejected")
    assert.equal(planTransition(ORDER_MACHINE, "pending_payment", "confirmed", { ...allocated, paymentStatus: "pending_reconciliation" }).kind, "rejected")
    assert.equal(planTransition(ORDER_MACHINE, "pending_payment", "confirmed", { ...allocated, paymentStatus: "captured", amountMatches: false }).kind, "rejected")
    assert.equal(planTransition(ORDER_MACHINE, "pending_payment", "confirmed", { ...allocated, paymentStatus: "captured" }).kind, "apply")
  })

  test("amount mismatch or late capture becomes an exception, never a confirmation", () => {
    assert.equal(planTransition(ORDER_MACHINE, "pending_payment", "needs_review", { paymentStatus: "captured", amountMatches: false, reservationStatus: "active" }).kind, "apply")
    assert.equal(planTransition(ORDER_MACHINE, "pending_payment", "needs_review", { paymentStatus: "captured", amountMatches: true, reservationStatus: "released" }).kind, "apply")
    assert.equal(planTransition(ORDER_MACHINE, "pending_payment", "confirmed", { paymentStatus: "captured", amountMatches: true, reservationStatus: "released" }).kind, "rejected")
  })

  test("no unpaid fulfilment", () => {
    for (const orderStatus of ["pending_payment", "needs_review", "cancelled"]) {
      assert.equal(planTransition(FULFILMENT_MACHINE, "unfulfilled", "packing", { orderStatus, reservationStatus: "allocated" }).kind, "rejected", orderStatus)
    }
    assert.equal(planTransition(FULFILMENT_MACHINE, "unfulfilled", "packing", { orderStatus: "confirmed", reservationStatus: "allocated" }).kind, "apply")
    assert.equal(planTransition(FULFILMENT_MACHINE, "unfulfilled", "handed_over", { orderStatus: "confirmed", source: "provider", hasAwb: true }).kind, "rejected")
  })

  test("payment alone never ships: handover needs a courier pickup scan with an AWB", () => {
    assert.equal(planTransition(FULFILMENT_MACHINE, "packed", "handed_over", { source: "staff", staffApproved: true, hasAwb: true }).kind, "rejected")
    assert.equal(planTransition(FULFILMENT_MACHINE, "packed", "handed_over", { source: "provider", hasAwb: true }).kind, "apply")
    assert.equal(planTransition(SHIPMENT_MACHINE, "booking_requested", "booked", { source: "provider", hasAwb: true, fulfilmentStatus: "unfulfilled" }).kind, "rejected")
  })

  test("stock is never released while a capture exists", () => {
    assert.equal(planTransition(RESERVATION_MACHINE, "active", "released", { paymentStatus: "captured", reservationExpired: true }).kind, "rejected")
    assert.equal(planTransition(RESERVATION_MACHINE, "active", "released", { paymentStatus: "created", reservationExpired: true }).kind, "apply")
    assert.equal(planTransition(RESERVATION_MACHINE, "allocated", "released", { orderStatus: "cancelled", fulfilmentStatus: "handed_over" }).kind, "rejected")
  })

  test("only verified provider facts move payment status", () => {
    assert.equal(planTransition(PAYMENT_MACHINE, "created", "captured", { source: "customer" }).kind, "rejected")
    assert.equal(planTransition(PAYMENT_MACHINE, "created", "captured", { source: "staff", staffApproved: true }).kind, "rejected")
    assert.equal(planTransition(PAYMENT_MACHINE, "created", "captured", { source: "provider" }).kind, "apply")
    assert.equal(planTransition(PAYMENT_MACHINE, "created", "pending_reconciliation", { source: "system" }).kind, "apply")
  })

  test("order and shipment statuses stay separate", () => {
    const shared = ORDER_MACHINE.states.filter(s => SHIPMENT_MACHINE.states.includes(s) || PAYMENT_MACHINE.states.includes(s))
    assert.deepEqual(shared, ["cancelled"], "only the generic word 'cancelled' may repeat")
    assert.ok(!ORDER_MACHINE.states.some(s => ["captured", "shipped", "delivered", "refunded"].includes(s)), "order status does not copy payment or shipment status")
  })
})
