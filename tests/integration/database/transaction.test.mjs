// CHV-S04-004: a rejected transaction rolls back all stock and order writes.
// Also exercises the compare-and-set transition helper (lib/db/transitions.ts).
import { after, before, describe, test } from "node:test"
import assert from "node:assert/strict"
import { ConcurrentUpdateError, TransitionRejectedError, transitionOrder } from "../../../apps/api/src/db/transitions.ts"
import { dropDatabase, freshDatabase, makeVariant, orderData, unique } from "./helpers.mjs"

const NAME = "chaanavya_test_transaction"
let db

before(() => ({ client: db } = freshDatabase(NAME)))
after(async () => {
  await db?.$disconnect()
  dropDatabase(NAME)
})

class OutOfStock extends Error {}

/** Reserves units only if enough are available, in the same statement (no read-then-write race). */
async function reserve(tx, variantId, quantity) {
  const updated = await tx.$executeRaw`UPDATE inventory_balance SET reserved = reserved + ${quantity}, version = version + 1 WHERE variant_id = ${variantId}::uuid AND on_hand - reserved - allocated >= ${quantity}`
  if (updated !== 1) throw new OutOfStock(variantId)
}

async function checkout(lines) {
  return db.$transaction(async tx => {
    const order = await tx.order.create({ data: orderData() })
    const reservation = await tx.inventoryReservation.create({ data: { orderId: order.id, expiresAt: new Date(Date.now() + 900_000), idempotencyKey: unique("reserve") } })
    for (const { variant, quantity } of lines) {
      await tx.inventoryReservationLine.create({ data: { reservationId: reservation.id, variantId: variant.id, quantity } })
      await reserve(tx, variant.id, quantity)
      await tx.inventoryMovement.create({ data: { variantId: variant.id, type: "reservation", quantity, reason: "checkout", actorKind: "system", referenceType: "reservation", referenceId: reservation.id } })
    }
    return order
  })
}

const snapshot = async variants => ({
  orders: await db.order.count(),
  reservations: await db.inventoryReservation.count(),
  movements: await db.inventoryMovement.count(),
  balances: await Promise.all(variants.map(v => db.inventoryBalance.findUniqueOrThrow({ where: { variantId: v.id } }))),
})

describe("CHV-S04-004 rollback", () => {
  test("a shortage on the second SKU undoes the order, the reservation and the first SKU's stock", async () => {
    const a = (await makeVariant(db, { onHand: 5 })).variant
    const b = (await makeVariant(db, { onHand: 1 })).variant
    const before = await snapshot([a, b])
    await assert.rejects(checkout([{ variant: a, quantity: 2 }, { variant: b, quantity: 2 }]), OutOfStock)
    assert.deepEqual(await snapshot([a, b]), before)
  })

  test("a database constraint failure mid-transaction also rolls everything back", async () => {
    const a = (await makeVariant(db, { onHand: 5 })).variant
    const before = await snapshot([a])
    await assert.rejects(
      db.$transaction(async tx => {
        await tx.order.create({ data: orderData() })
        await tx.inventoryBalance.update({ where: { variantId: a.id }, data: { reserved: { increment: 2 } } })
        await tx.inventoryBalance.update({ where: { variantId: a.id }, data: { reserved: { increment: 10 } } }) // breaks available >= 0
      }),
    )
    assert.deepEqual(await snapshot([a]), before)
  })

  test("the happy path commits every write together", async () => {
    const a = (await makeVariant(db, { onHand: 5 })).variant
    const b = (await makeVariant(db, { onHand: 1 })).variant
    const order = await checkout([{ variant: a, quantity: 2 }, { variant: b, quantity: 1 }])
    assert.ok(await db.inventoryReservation.findUnique({ where: { orderId: order.id } }))
    assert.equal((await db.inventoryBalance.findUniqueOrThrow({ where: { variantId: b.id } })).reserved, 1)
    await assert.rejects(checkout([{ variant: b, quantity: 1 }]), OutOfStock, "the last unit is already reserved")
  })
})

describe("transaction-safe status transitions", () => {
  const confirmFacts = { paymentStatus: "captured", amountMatches: true, reservationStatus: "allocated" }
  const actor = { kind: "system", id: null }

  test("a transition and its audit event commit together", async () => {
    const order = await db.order.create({ data: orderData() })
    const result = await db.$transaction(tx => transitionOrder(tx, { orderId: order.id, from: "pending_payment", to: "confirmed", facts: confirmFacts, actor, correlationId: unique("corr") }))
    assert.equal(result, "applied")
    assert.equal((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status, "confirmed")
    const audit = await db.auditEvent.findFirstOrThrow({ where: { entityId: order.id } })
    assert.equal(audit.reason, "payment_captured_amount_matches_stock_allocated")
  })

  test("a stale writer loses: the second transition from the same state is refused", async () => {
    const order = await db.order.create({ data: orderData() })
    await db.$transaction(tx => transitionOrder(tx, { orderId: order.id, from: "pending_payment", to: "confirmed", facts: confirmFacts, actor, correlationId: unique("corr") }))
    await assert.rejects(
      db.$transaction(tx => transitionOrder(tx, { orderId: order.id, from: "pending_payment", to: "needs_review", facts: { paymentStatus: "captured", amountMatches: false }, actor, correlationId: unique("corr") })),
      ConcurrentUpdateError,
    )
    assert.equal(await db.auditEvent.count({ where: { entityId: order.id } }), 1)
  })

  test("an illegal or unproven transition writes nothing", async () => {
    const order = await db.order.create({ data: orderData() })
    await assert.rejects(db.$transaction(tx => transitionOrder(tx, { orderId: order.id, from: "pending_payment", to: "confirmed", facts: { paymentStatus: "authorized" }, actor, correlationId: unique("corr") })), TransitionRejectedError)
    assert.equal((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status, "pending_payment")
    assert.equal(await db.auditEvent.count({ where: { entityId: order.id } }), 0)
  })

  test("if the audit write fails, the status change is rolled back", async () => {
    const order = await db.order.create({ data: orderData() })
    await assert.rejects(db.$transaction(tx => transitionOrder(tx, { orderId: order.id, from: "pending_payment", to: "confirmed", facts: confirmFacts, actor, correlationId: undefined })))
    assert.equal((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status, "pending_payment")
  })

  test("replaying a transition already applied is a no-op", async () => {
    const order = await db.order.create({ data: orderData({ status: "confirmed" }) })
    assert.equal(await db.$transaction(tx => transitionOrder(tx, { orderId: order.id, from: "confirmed", to: "confirmed", facts: {}, actor, correlationId: unique("corr") })), "noop")
  })
})
