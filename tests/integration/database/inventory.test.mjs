// Stage 09 inventory against a real database, using the API's own inventory code (no HTTP):
//   CHV-S09-001  100 concurrent requests for one unit cannot oversell; multi-SKU holds are all or nothing
//   CHV-S09-002  expired or cancelled holds are released exactly once; late payments are handled safely
//   CHV-S09-005  stock stays consistent after a simulated worker failure and retry
import { after, before, describe, test } from "node:test"
import assert from "node:assert/strict"
import { createLogger } from "../../../packages/shared/src/observability/logger.ts"
import { handleLateCapture, PAYMENT_GRACE_MS, releaseForCancelledOrder, reserveStock, settleReservation } from "../../../apps/api/src/inventory/reservations.ts"
import { applyMovement } from "../../../apps/api/src/inventory/ledger.ts"
import { reservationExpiryJob } from "../../../apps/worker/src/jobs/reservation-expiry.ts"
import { inventoryReconciliationJob, problemsOf, reconciliationQuery } from "../../../apps/worker/src/jobs/inventory-reconciliation.ts"
import { runOnce } from "../../../apps/worker/src/runner.ts"
import { dropDatabase, freshDatabase, makeVariant, orderData, unique } from "./helpers.mjs"

const NAME = "chaanavya_test_s09_inventory"
const logger = createLogger({ base: { service: "inventory-test" }, sink: () => {} })
let db

before(() => {
  db = freshDatabase(NAME).client
})
after(async () => {
  await db?.$disconnect()
  dropDatabase(NAME)
})

/** A sellable SKU: live product, counted in an approved stocktake, `onHand` units received through the ledger. */
async function sellable(onHand) {
  const { product, variant } = await makeVariant(db, { onHand: 0 })
  await db.inventoryBalance.update({ where: { variantId: variant.id }, data: { lastCountedAt: new Date() } })
  if (onHand) await db.$transaction(tx => applyMovement(tx, { variantId: variant.id, type: "receipt", quantity: onHand, reason: "test stock", reasonCode: "receipt", actor: { kind: "system", id: null }, reference: { type: "test", id: "fixture" } }))
  return { product, variant }
}

const order = () => db.order.create({ data: orderData() })
const balance = variantId => db.inventoryBalance.findUnique({ where: { variantId } })
const reserve = (orderId, lines, extra = {}) => reserveStock(db, { orderId, lines, idempotencyKey: unique("key"), correlationId: "test", ...extra })

describe("CHV-S09-001 no overselling", () => {
  test("100 concurrent requests for the last unit: exactly one hold succeeds", async () => {
    const { variant } = await sellable(1)
    const orders = await Promise.all(Array.from({ length: 100 }, order))
    const results = await Promise.all(orders.map(o => reserve(o.id, [{ variantId: variant.id, quantity: 1 }])))
    assert.equal(results.filter(r => r.ok).length, 1)
    assert.ok(results.filter(r => !r.ok).every(r => r.reason === "out_of_stock"), JSON.stringify(results.find(r => !r.ok && r.reason !== "out_of_stock")))
    const b = await balance(variant.id)
    assert.deepEqual([b.onHand, b.reserved, b.allocated], [1, 1, 0])
    assert.equal(await db.inventoryMovement.count({ where: { variantId: variant.id, type: "reservation" } }), 1)
    assert.equal(await db.inventoryReservation.count({ where: { lines: { some: { variantId: variant.id } } } }), 1)
  })

  test("a hold covers every line or none", async () => {
    const a = await sellable(5)
    const b = await sellable(2)
    const o = await order()
    const result = await reserve(o.id, [{ variantId: a.variant.id, quantity: 1 }, { variantId: b.variant.id, quantity: 3 }])
    assert.deepEqual(result, { ok: false, reason: "out_of_stock", variantIds: [b.variant.id] })
    assert.equal((await balance(a.variant.id)).reserved, 0, "the first line was rolled back")
    assert.equal(await db.inventoryReservation.count({ where: { orderId: o.id } }), 0)
  })

  test("uncounted, draft or archived SKUs are never held; the same key returns the same hold", async () => {
    const { variant } = await makeVariant(db, { onHand: 5 })
    const o = await order()
    assert.deepEqual(await reserve(o.id, [{ variantId: variant.id, quantity: 1 }]), { ok: false, reason: "not_sellable", variantIds: [variant.id] })
    const counted = await sellable(3)
    const key = unique("same")
    const first = await reserve(o.id, [{ variantId: counted.variant.id, quantity: 2 }], { idempotencyKey: key })
    const again = await reserve(o.id, [{ variantId: counted.variant.id, quantity: 2 }], { idempotencyKey: key })
    assert.ok(first.ok && again.ok && again.replayed)
    assert.equal(again.reservationId, first.reservationId)
    assert.equal((await balance(counted.variant.id)).reserved, 2)
    assert.equal((await reserve(o.id, [{ variantId: counted.variant.id, quantity: 1 }], { idempotencyKey: key })).reason, "key_reused")
    for (const ttlSeconds of [10, 7200]) assert.equal((await reserve((await order()).id, [{ variantId: counted.variant.id, quantity: 1 }], { ttlSeconds })).reason, "invalid", "holds are bounded")
  })

  test("the database itself refuses a negative balance", async () => {
    const { variant } = await sellable(1)
    await assert.rejects(db.inventoryBalance.update({ where: { variantId: variant.id }, data: { reserved: 2 } }), /available_non_negative|check constraint/)
  })
})

describe("CHV-S09-002 holds end exactly once", () => {
  test("an expired hold is released once, even with ten settlers racing", async () => {
    const { variant } = await sellable(3)
    const o = await order()
    const hold = await reserve(o.id, [{ variantId: variant.id, quantity: 2 }])
    await db.inventoryReservation.update({ where: { id: hold.reservationId }, data: { expiresAt: new Date(Date.now() - 1000) } })
    const outcomes = await Promise.all(Array.from({ length: 10 }, () => db.$transaction(tx => settleReservation(tx, hold.reservationId, "race")).catch(e => `error:${e.code ?? e.message}`)))
    assert.equal(outcomes.filter(o => o === "released").length, 1, JSON.stringify(outcomes))
    const b = await balance(variant.id)
    assert.deepEqual([b.onHand, b.reserved], [3, 0])
    assert.equal(await db.inventoryMovement.count({ where: { referenceId: hold.reservationId, type: "release" } }), 1)
    assert.equal((await db.inventoryReservation.findUnique({ where: { id: hold.reservationId } })).status, "released")
    assert.equal(await db.$transaction(tx => settleReservation(tx, hold.reservationId, "again")), "noop")
  })

  test("a cancelled order's hold is released once; a hold that has not expired stays", async () => {
    const { variant } = await sellable(2)
    const o = await order()
    const hold = await reserve(o.id, [{ variantId: variant.id, quantity: 1 }])
    assert.equal(await db.$transaction(tx => settleReservation(tx, hold.reservationId, "early")), "noop")
    assert.equal(await releaseForCancelledOrder(db, hold.reservationId, "cancel"), "applied")
    assert.equal(await releaseForCancelledOrder(db, hold.reservationId, "cancel"), "noop")
    assert.equal((await balance(variant.id)).reserved, 0)
  })

  test("a captured payment for the full amount allocates the units instead of releasing them", async () => {
    const { variant } = await sellable(2)
    const o = await order()
    const hold = await reserve(o.id, [{ variantId: variant.id, quantity: 1 }])
    await db.paymentAttempt.create({ data: { orderId: o.id, provider: "razorpay", mode: "test", amountPaise: o.grandTotalPaise, status: "captured", capturedAmountPaise: o.grandTotalPaise, idempotencyKey: unique("pay") } })
    await db.inventoryReservation.update({ where: { id: hold.reservationId }, data: { expiresAt: new Date(Date.now() - 1000) } })
    assert.equal(await db.$transaction(tx => settleReservation(tx, hold.reservationId, "capture")), "allocated")
    const b = await balance(variant.id)
    assert.deepEqual([b.onHand, b.reserved, b.allocated], [2, 0, 1])
  })

  test("a payment still in flight keeps its hold through the grace period, then the hold is released", async () => {
    const { variant } = await sellable(2)
    const o = await order()
    const hold = await reserve(o.id, [{ variantId: variant.id, quantity: 1 }])
    await db.paymentAttempt.create({ data: { orderId: o.id, provider: "razorpay", mode: "test", amountPaise: o.grandTotalPaise, status: "authorized", idempotencyKey: unique("pay") } })
    const expired = new Date(Date.now() - 1000)
    await db.inventoryReservation.update({ where: { id: hold.reservationId }, data: { expiresAt: expired } })
    assert.equal(await db.$transaction(tx => settleReservation(tx, hold.reservationId, "grace")), "held_for_payment")
    const later = new Date(expired.getTime() + PAYMENT_GRACE_MS + 1000)
    assert.equal(await db.$transaction(tx => settleReservation(tx, hold.reservationId, "grace", later)), "released")
  })

  test("a capture that arrives after release sends the order to review and never grabs stock", async () => {
    const { variant } = await sellable(1)
    const o = await order()
    const hold = await reserve(o.id, [{ variantId: variant.id, quantity: 1 }])
    await db.inventoryReservation.update({ where: { id: hold.reservationId }, data: { expiresAt: new Date(Date.now() - 1000) } })
    assert.equal(await db.$transaction(tx => settleReservation(tx, hold.reservationId, "expire")), "released")
    // Someone else buys the unit meanwhile.
    const other = await order()
    assert.ok((await reserve(other.id, [{ variantId: variant.id, quantity: 1 }])).ok)
    await db.paymentAttempt.create({ data: { orderId: o.id, provider: "razorpay", mode: "test", amountPaise: o.grandTotalPaise, status: "captured", capturedAmountPaise: o.grandTotalPaise, idempotencyKey: unique("pay") } })
    assert.equal(await handleLateCapture(db, o.id, "late"), "needs_review")
    assert.equal(await handleLateCapture(db, o.id, "late"), "noop", "safe to repeat")
    assert.equal((await db.order.findUnique({ where: { id: o.id } })).status, "needs_review")
    const b = await balance(variant.id)
    assert.deepEqual([b.onHand, b.reserved, b.allocated], [1, 1, 0], "the other shopper keeps the unit")
    assert.ok(await db.auditEvent.findFirst({ where: { action: "order.transition", entityId: o.id, reason: "capture_mismatched_or_stock_released" } }))
  })
})

describe("CHV-S09-005 worker failure and retry", () => {
  test("a crash after settling rolls the settlement back; the retry releases exactly once and the books agree", async () => {
    const { variant } = await sellable(4)
    const holds = []
    for (let i = 0; i < 3; i++) holds.push(await reserve((await order()).id, [{ variantId: variant.id, quantity: 1 }]))
    for (const h of holds) await db.inventoryReservation.update({ where: { id: h.reservationId }, data: { expiresAt: new Date(Date.now() - 1000) } })

    // First run: the worker dies right after settling the second hold (before its commit).
    let calls = 0
    const crashing = async (tx, id, correlationId, now) => {
      const outcome = await settleReservation(tx, id, correlationId, now)
      if (++calls === 2) throw new Error("simulated crash")
      return outcome
    }
    const first = await runOnce(db, reservationExpiryJob(db, crashing), logger)
    assert.equal(first, "ok")
    const mid = await balance(variant.id)
    assert.equal(mid.reserved, 1, "the crash rolled back only its own hold; the job carried on with the others")
    assert.equal(await db.inventoryMovement.count({ where: { referenceId: holds[1].reservationId, type: "release" } }), 0, "nothing of the crashed settlement was kept")

    // Retry with the real settler: every remaining hold released once.
    await runOnce(db, reservationExpiryJob(db, settleReservation), logger)
    await runOnce(db, reservationExpiryJob(db, settleReservation), logger)
    const end = await balance(variant.id)
    assert.deepEqual([end.onHand, end.reserved], [4, 0])
    for (const h of holds) assert.equal(await db.inventoryMovement.count({ where: { referenceId: h.reservationId, type: "release" } }), 1, h.reservationId)
    const row = (await db.$transaction(tx => reconciliationQuery(tx))).find(r => r.variant_id === variant.id)
    assert.deepEqual(problemsOf(row), [])
  })

  test("reconciliation reports a balance that disagrees with the ledger, once, and changes nothing", async () => {
    const { variant } = await sellable(2)
    await db.$executeRaw`UPDATE "inventory_balance" SET "on_hand" = 5 WHERE "variant_id" = ${variant.id}::uuid`
    assert.equal(await runOnce(db, inventoryReconciliationJob, logger), "ok")
    assert.equal(await runOnce(db, inventoryReconciliationJob, logger), "ok")
    const events = await db.auditEvent.findMany({ where: { action: "inventory.discrepancy", entityId: variant.id } })
    assert.equal(events.length, 1, "reported once")
    assert.match(events[0].after.problem, /on hand 5 but the ledger adds up to 2/)
    assert.equal((await balance(variant.id)).onHand, 5, "never fixed automatically")
  })
})
