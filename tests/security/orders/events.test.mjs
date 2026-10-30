// CHV-S13-M08: the order event and audit trail (migration 20261029020000_order_events,
// apps/api/src/db/origin.ts, the transition functions and order placement). Every sensitive change
// to an order (placement, status, fulfilment, payment, stock hold) leaves one append-only event naming
// its origin: the actor, the request's correlation id and the rule met. A change without a declared
// origin is refused by the database itself. Retries and parallel submissions never add a second
// event. Nothing personal is stored. Calls go through the web host's forwarder; tax values are
// synthetic test values; delivery is the sandbox courier.
import { after, before, describe, test } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { apiModule, call, createStaff, Jar, newIp, setup, signInCustomer, withOrigin } from "../auth/helpers.mjs"

let ctx, forward, transitions, reservations
let n = 0

const api = (method, path, { jar, body, headers = {} } = {}) => call(forward, `/api/cart${path}`, { method, jar, body, headers, ip: newIp() })
const address = { name: "Synthetic Buyer", phone: "+91 60000 00000", line1: "1 Example Road", line2: null, landmark: "Near the park", city: "Bengaluru", district: "Bengaluru Urban", stateCode: "IN-KA", pinCode: "560034" }
const RAZORPAY = { kind: "provider", id: "razorpay" }
const COURIER = { kind: "provider", id: "shiprocket" }
const STAFF = { kind: "staff", id: null }
const PAID = { paymentStatus: "captured", amountMatches: true, reservationStatus: "allocated" }

async function variant() {
  n += 1
  const p = await ctx.db.product.create({
    data: { handle: `fixture-events-${n}`, title: `Fixture events ${n}`, status: "active", publishedAt: new Date(), shippingRestriction: "none", variants: { create: [{ sku: `fixture-events-${n}-m`, title: "M", optionKey: "size:m", pricePaise: 189900n, taxCategory: "apparel_cotton", weightGrams: 400 }] } },
    include: { variants: true },
  })
  await ctx.db.inventoryBalance.create({ data: { variantId: p.variants[0].id, onHand: 20, lastCountedAt: new Date() } })
  return p.variants[0].id
}

/** A shopper's bag, contact step and checked quote; then placing it, with a correlation id of our own. */
async function quoted(jar = new Jar(), { guest = true } = {}) {
  assert.equal((await api("POST", "/lines", { jar, body: { variantId: await variant(), quantity: 1 }, headers: { "idempotency-key": randomUUID() } })).status, 200)
  assert.equal((await api("PUT", "/contact", { jar, body: { shippingAddress: address, ...(guest ? { email: "buyer@example.com" } : {}) } })).status, 200)
  const quote = (await api("POST", "/quote", { jar, body: {} })).json.data
  assert.ok(quote?.id)
  return { jar, quote }
}
const place = (jar, quote, { key = randomUUID(), correlation = randomUUID() } = {}) =>
  api("POST", "/order", { jar, body: { quoteId: quote.id, expectedGrandTotal: quote.grandTotal }, headers: { "idempotency-key": key, "x-correlation-id": correlation } })
const events = orderId => ctx.db.orderEvent.findMany({ where: { orderId }, orderBy: { occurredAt: "asc" } })
const inTx = fn => ctx.db.$transaction(tx => fn(tx))

before(async () => {
  ctx = await setup("chaanavya_test_s13_order_events")
  forward = ctx.routes.me.GET
  transitions = await apiModule("db/transitions")
  reservations = await apiModule("inventory/reservations")
  const { user } = await createStaff(ctx, "s13.events.owner@example.com", "OWNER")
  await ctx.db.taxProfile.create({ data: { sellerStateCode: "IN-KA", pricesIncludeTax: true, note: "synthetic test values", createdById: user.id, rates: { create: [{ taxCategory: "apparel_cotton", hsnCode: "6204", rateBasisPoints: 500 }] } } })
})
after(() => ctx?.teardown())


// Since Stage 13.11 an order's stock hold speaks for itself: confirming needs the hold really allocated.
const allocate = async order => {
  const hold = await ctx.db.inventoryReservation.findUniqueOrThrow({ where: { orderId: order.id } })
  await inTx(tx => reservations.transitionReservation(tx, hold.id, "allocated", { paymentStatus: "captured", amountMatches: true }, "payment captured", randomUUID()))
}
describe("CHV-S13-M08 every sensitive transition has an auditable origin", () => {
  test("placing an order records one 'placed' event: the guest, the request's correlation id, and a redacted context", async () => {
    const { jar, quote } = await quoted()
    const correlation = randomUUID()
    const res = await place(jar, quote, { correlation })
    assert.equal(res.status, 201, JSON.stringify(res.json))
    const order = res.json.data
    const [placed, ...rest] = await events(order.id)
    assert.equal(rest.length, 0)
    assert.deepEqual([placed.kind, placed.fromState, placed.toState, placed.actorKind, placed.actorId, placed.correlationId, placed.reason], ["placed", null, "pending_payment", "guest", null, correlation, "order_placed_from_checked_quote"])
    const hold = await ctx.db.inventoryReservation.findUniqueOrThrow({ where: { orderId: order.id } })
    assert.deepEqual(placed.context, { number: order.number, quoteId: quote.id, grandTotalPaise: quote.grandTotal.amountPaise, lineCount: 1, reservationId: hold.id, test: true })
    const row = await ctx.db.order.findUniqueOrThrow({ where: { id: order.id } })
    const stored = JSON.stringify(await events(order.id))
    for (const secret of [row.email, "Synthetic Buyer", "+916000000000", "1 Example Road", "Near the park", "560034", row.submitKey, row.guestSessionId]) assert.ok(!stored.includes(secret), `the trail never holds ${secret}`)
  })

  test("a signed-in customer's placement names the customer's account", async () => {
    const email = `s13.events.${randomUUID().slice(0, 8)}@example.com`
    const jar = await signInCustomer(ctx, email)
    const { quote } = await quoted(jar, { guest: false })
    const order = (await place(jar, quote)).json.data
    const user = await ctx.db.user.findUniqueOrThrow({ where: { email } })
    const [placed] = await events(order.id)
    assert.deepEqual([placed.actorKind, placed.actorId], ["customer", user.id])
    assert.ok(!JSON.stringify(placed).includes(email))
  })

  test("every move after placing is recorded once, with its actor, request and rule: payment, hold, order, fulfilment", async () => {
    const { jar, quote } = await quoted()
    const order = (await place(jar, quote)).json.data
    const hold = await ctx.db.inventoryReservation.findUniqueOrThrow({ where: { orderId: order.id } })
    const attempt = await ctx.db.paymentAttempt.create({ data: { orderId: order.id, provider: "razorpay", mode: "test", amountPaise: BigInt(quote.grandTotal.amountPaise), idempotencyKey: randomUUID() } })
    const ids = { pay: randomUUID(), hold: randomUUID(), confirm: randomUUID(), pack: randomUUID(), packed: randomUUID(), ship: randomUUID() }
    await inTx(tx => transitions.transitionPayment(tx, { paymentAttemptId: attempt.id, from: "created", to: "captured", facts: {}, actor: RAZORPAY, correlationId: ids.pay }))
    await inTx(tx => reservations.transitionReservation(tx, hold.id, "allocated", { paymentStatus: "captured", amountMatches: true }, "payment captured", ids.hold))
    await inTx(tx => transitions.transitionOrder(tx, { orderId: order.id, from: "pending_payment", to: "confirmed", facts: PAID, actor: RAZORPAY, correlationId: ids.confirm }))
    await inTx(tx => transitions.transitionFulfilment(tx, { orderId: order.id, from: "unfulfilled", to: "packing", facts: { reservationStatus: "allocated" }, actor: STAFF, correlationId: ids.pack }))
    await inTx(tx => transitions.transitionFulfilment(tx, { orderId: order.id, from: "packing", to: "packed", facts: { staffApproved: true }, actor: STAFF, correlationId: ids.packed }))
    await inTx(tx => transitions.transitionFulfilment(tx, { orderId: order.id, from: "packed", to: "handed_over", facts: { hasAwb: true }, actor: COURIER, correlationId: ids.ship }))
    const trail = (await events(order.id)).map(e => [e.kind, e.fromState, e.toState, e.actorKind, e.actorId, e.correlationId])
    assert.deepEqual(trail.slice(1), [
      ["payment", "created", "captured", "provider", "razorpay", ids.pay],
      ["reservation", "active", "allocated", "system", null, ids.hold],
      ["status", "pending_payment", "confirmed", "provider", "razorpay", ids.confirm],
      ["fulfilment", "unfulfilled", "packing", "staff", null, ids.pack],
      ["fulfilment", "packing", "packed", "staff", null, ids.packed],
      ["fulfilment", "packed", "handed_over", "provider", "shiprocket", ids.ship],
    ])
    assert.ok((await events(order.id)).slice(1).every(e => e.reason.length > 0), "every move names the rule it met")
  })

  test("the trail explains the order's current state: each event starts where the last one ended", async () => {
    const { jar, quote } = await quoted()
    const order = (await place(jar, quote)).json.data
    await allocate(order)
    await inTx(tx => transitions.transitionOrder(tx, { orderId: order.id, from: "pending_payment", to: "confirmed", facts: PAID, actor: RAZORPAY, correlationId: randomUUID() }))
    await inTx(tx => transitions.transitionOrder(tx, { orderId: order.id, from: "confirmed", to: "cancelled", facts: { refundRequested: true, staffApproved: true }, actor: { kind: "staff", id: null }, correlationId: randomUUID() }))
    const statusTrail = (await events(order.id)).filter(e => e.kind === "placed" || e.kind === "status")
    for (let i = 1; i < statusTrail.length; i++) assert.equal(statusTrail[i].fromState, statusTrail[i - 1].toState)
    assert.equal(statusTrail.at(-1).toState, (await ctx.db.order.findUniqueOrThrow({ where: { id: order.id } })).status)
  })
})

describe("CHV-S13-M08 no origin, no change", () => {
  test("a direct status change without a declared origin is refused, for orders, payments and holds", async () => {
    const { jar, quote } = await quoted()
    const order = (await place(jar, quote)).json.data
    const hold = await ctx.db.inventoryReservation.findUniqueOrThrow({ where: { orderId: order.id } })
    const attempt = await ctx.db.paymentAttempt.create({ data: { orderId: order.id, provider: "razorpay", mode: "test", amountPaise: 1n, idempotencyKey: randomUUID() } })
    await assert.rejects(ctx.db.order.update({ where: { id: order.id }, data: { status: "cancelled" } }), /no auditable origin/)
    await assert.rejects(ctx.db.paymentAttempt.update({ where: { id: attempt.id }, data: { status: "failed" } }), /no auditable origin/)
    await assert.rejects(ctx.db.inventoryReservation.update({ where: { id: hold.id }, data: { status: "released" } }), /no auditable origin/)
    await assert.rejects(ctx.db.$executeRaw`UPDATE "order" SET status = 'cancelled' WHERE id = ${order.id}::uuid`, /no auditable origin/)
    assert.equal((await ctx.db.order.findUniqueOrThrow({ where: { id: order.id } })).status, "pending_payment")
    assert.equal((await events(order.id)).length, 1, "nothing but the placement")
  })

  test("an origin missing its actor or correlation id does not count, and an origin never outlives its transaction", async () => {
    const { jar, quote } = await quoted()
    const order = (await place(jar, quote)).json.data
    await assert.rejects(withOrigin(ctx.db, tx => tx.order.update({ where: { id: order.id }, data: { status: "cancelled" } }), { actorKind: "system", correlationId: "" }), /no auditable origin/)
    await assert.rejects(withOrigin(ctx.db, tx => tx.order.update({ where: { id: order.id }, data: { status: "cancelled" } }), { correlationId: "x" }), /no auditable origin/)
    await withOrigin(ctx.db, tx => tx.$queryRaw`SELECT 1`)
    await assert.rejects(ctx.db.order.update({ where: { id: order.id }, data: { status: "cancelled" } }), /no auditable origin/, "the next transaction starts with no origin")
  })

  test("the trail is append-only and refuses personal data", async () => {
    const { jar, quote } = await quoted()
    const order = (await place(jar, quote)).json.data
    const [placed] = await events(order.id)
    await assert.rejects(ctx.db.orderEvent.update({ where: { id: placed.id }, data: { actorKind: "staff" } }), /append-only/)
    await assert.rejects(ctx.db.orderEvent.delete({ where: { id: placed.id } }), /append-only/)
    for (const key of ["email", "phone", "address", "guestSessionId", "submitKey"]) {
      await assert.rejects(ctx.db.orderEvent.create({ data: { orderId: order.id, kind: "status", subjectId: order.id, toState: "cancelled", actorKind: "system", correlationId: "x", context: { [key]: "secret" } } }), /order_event_context_redacted/, key)
    }
  })
})

describe("CHV-S13-M08 retries never duplicate events", () => {
  test("replays with the same key or the same quote add no second placement", async () => {
    const { jar, quote } = await quoted()
    const key = randomUUID()
    const order = (await place(jar, quote, { key })).json.data
    await place(jar, quote, { key })
    await place(jar, quote)
    assert.deepEqual((await events(order.id)).map(e => e.kind), ["placed"])
  })

  test("parallel submissions of one quote leave exactly one placement event", async () => {
    const { jar, quote } = await quoted()
    const results = await Promise.all(Array.from({ length: 6 }, () => place(jar, quote)))
    const id = results.find(r => r.status === 201).json.data.id
    assert.equal(await ctx.db.orderEvent.count({ where: { orderId: id, kind: "placed" } }), 1)
  })

  test("a repeated move (a retried callback or job) is a no-op and adds nothing", async () => {
    const { jar, quote } = await quoted()
    const order = (await place(jar, quote)).json.data
    await allocate(order)
    const confirm = () => inTx(tx => transitions.transitionOrder(tx, { orderId: order.id, from: "pending_payment", to: "confirmed", facts: PAID, actor: RAZORPAY, correlationId: randomUUID() }))
    assert.equal(await confirm(), "applied")
    assert.equal(await confirm(), "noop")
    assert.equal(await confirm(), "noop")
    assert.equal(await ctx.db.orderEvent.count({ where: { orderId: order.id, kind: "status" } }), 1)
  })

  test("the database itself refuses a second placement event", async () => {
    const { jar, quote } = await quoted()
    const order = (await place(jar, quote)).json.data
    await assert.rejects(ctx.db.orderEvent.create({ data: { orderId: order.id, kind: "placed", subjectId: order.id, toState: "pending_payment", actorKind: "guest", correlationId: "retry" } }), /Unique constraint|order_event_placed_once/)
  })
})
