// CHV-S13-M14: order recovery reconciliation (apps/api/src/orders/recovery.ts, the worker's order-reconciliation
// job, /api/admin/order-recovery). Stuck orders and stock holds are surfaced as cases for a person, and nothing
// else changes: no order, payment, stock hold, stock movement or order event is written by a run, and no
// payment outcome is guessed. Runs are idempotent and safe to overlap; cases clear when their condition goes,
// and a case staff resolved does not come back while the facts stay the same.
// Tax values are synthetic test values; delivery is the sandbox courier.
import { after, before, describe, test } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import "reflect-metadata"
import { apiModule, call, Jar, newIp, setup, signInCustomer, staffWithMfa } from "../auth/helpers.mjs"
import { orderReconciliationJob } from "../../../apps/worker/src/jobs/order-reconciliation.ts"

let ctx, recovery, transitions, cancel, customer, staff, owner
let n = 0
const MIN = 60 * 1000
const RAZORPAY = { kind: "provider", id: "razorpay" }

const forward = () => ctx.routes.me.GET
// jar: null is a visitor with no session.
const cases = (query = "", { jar = staff.jar, origin } = {}) => call(forward(), `/api/admin/order-recovery/cases${query}`, { jar: jar ?? undefined, ip: newIp(), ...(origin !== undefined && { origin }) })
const resolve = (id, { jar = owner.jar, reason = "checked with the courier, nothing to do", origin } = {}) =>
  call(forward(), `/api/admin/order-recovery/cases/${id}/resolve`, { method: "POST", jar: jar ?? undefined, body: { reason }, ip: newIp(), ...(origin !== undefined && { origin }) })
const cart = (method, path, { jar, body, headers = {} } = {}) => call(forward(), `/api/cart${path}`, { method, jar, body, headers, ip: newIp() })
const address = { name: "Synthetic Buyer", phone: "+91 61234 56789", line1: "12 Fixture Lane", line2: null, landmark: null, city: "Bengaluru", district: "Bengaluru Urban", stateCode: "IN-KA", pinCode: "560034" }

/** A pending guest order for one item, with its stock hold. */
async function placeOrder() {
  n += 1
  const jar = new Jar()
  const p = await ctx.db.product.create({
    data: { handle: `fixture-recovery-${n}`, title: `Fixture recovery ${n}`, status: "active", publishedAt: new Date(), shippingRestriction: "none", variants: { create: [{ sku: `fixture-recovery-${n}-m`, title: "M", optionKey: "size:m", pricePaise: 99900n, taxCategory: "apparel_cotton", weightGrams: 300 }] } },
    include: { variants: true },
  })
  await ctx.db.inventoryBalance.create({ data: { variantId: p.variants[0].id, onHand: 5, lastCountedAt: new Date() } })
  assert.equal((await cart("POST", "/lines", { jar, body: { variantId: p.variants[0].id, quantity: 1 }, headers: { "idempotency-key": randomUUID() } })).status, 200)
  assert.equal((await cart("PUT", "/contact", { jar, body: { email: `recovery${n}@example.com`, shippingAddress: address } })).status, 200)
  const quote = (await cart("POST", "/quote", { jar, body: {} })).json.data
  const res = await cart("POST", "/order", { jar, body: { quoteId: quote.id, expectedGrandTotal: quote.grandTotal }, headers: { "idempotency-key": randomUUID() } })
  assert.equal(res.status, 201, JSON.stringify(res.json))
  return ctx.db.order.findUniqueOrThrow({ where: { id: res.json.data.id }, include: { reservation: true } })
}

/** Moves an order's status directly, as a declared system job would; its stock hold is left as it is. */
async function force(orderId, data) {
  await ctx.db.$transaction(async tx => {
    await tx.$queryRaw`SELECT set_config('chaanavya.origin', ${JSON.stringify({ actorKind: "system", actorId: null, correlationId: `test-${randomUUID()}` })}, true)`
    await tx.order.update({ where: { id: orderId }, data })
  })
}

const payment = async (order, to) => {
  const attempt = await ctx.db.paymentAttempt.create({ data: { orderId: order.id, provider: "razorpay", mode: "test", amountPaise: order.grandTotalPaise, idempotencyKey: randomUUID() } })
  if (to !== "created") await ctx.db.$transaction(tx => transitions.transitionPayment(tx, { paymentAttemptId: attempt.id, from: "created", to, facts: {}, actor: RAZORPAY, correlationId: randomUUID() }))
  return attempt
}

const pastWindow = order => new Date(order.payableUntil.getTime() + 16 * MIN)
const openCases = orderId => ctx.db.orderRecoveryCase.findMany({ where: { orderId, status: "open" }, orderBy: { kind: "asc" } })
const kinds = async orderId => (await openCases(orderId)).map(c => c.kind)

/** Everything a run must leave alone: orders, payments, holds, the stock ledger and the order trail. */
async function world() {
  const [orders, payments, holds, movements, events] = await Promise.all([
    ctx.db.order.findMany({ orderBy: { id: "asc" }, select: { id: true, status: true, fulfilmentStatus: true, heldAt: true, updatedAt: true } }),
    ctx.db.paymentAttempt.findMany({ orderBy: { id: "asc" }, select: { id: true, status: true, updatedAt: true } }),
    ctx.db.inventoryReservation.findMany({ orderBy: { id: "asc" }, select: { id: true, status: true, updatedAt: true } }),
    ctx.db.inventoryMovement.count(),
    ctx.db.orderEvent.count(),
  ])
  return JSON.stringify({ orders, payments, holds, movements, events })
}

before(async () => {
  ctx = await setup("chaanavya_test_s13_recovery")
  recovery = await apiModule("orders/recovery")
  transitions = await apiModule("db/transitions")
  cancel = await apiModule("orders/cancel")
  staff = await staffWithMfa(ctx, "s13.recovery.staff@example.com", "STAFF")
  owner = await staffWithMfa(ctx, "s13.recovery.owner@example.com", "OWNER")
  customer = await signInCustomer(ctx, "s13.recovery.customer@example.com")
  await ctx.db.taxProfile.create({ data: { sellerStateCode: "IN-KA", pricesIncludeTax: true, note: "synthetic test values", createdById: owner.user.id, rates: { create: [{ taxCategory: "apparel_cotton", hsnCode: "6204", rateBasisPoints: 500 }] } } })
})
after(() => ctx?.teardown())

describe("CHV-S13-M14 stuck orders are surfaced, and nothing else changes", () => {
  test("a fresh pending order is not stuck", async () => {
    const order = await placeOrder()
    await recovery.reconcileOrders(ctx.db, new Date(order.createdAt.getTime() + MIN))
    assert.deepEqual(await kinds(order.id), [])
  })

  test("a pending order past its window: a case for a person, and the order, hold and ledger untouched", async () => {
    const order = await placeOrder()
    const before_ = await world()
    const result = await recovery.reconcileOrders(ctx.db, pastWindow(order))
    assert.ok(result.opened >= 2)
    assert.equal(await world(), before_, "a run writes no order, payment, hold, movement or event")
    const found = await openCases(order.id)
    assert.deepEqual(found.map(c => [c.kind, c.check]), [["hold_overdue", "reservation_expiry_did_not_settle"], ["pending_past_window", "order_expiry_did_not_cancel"]])
    assert.deepEqual(found[0].facts, { orderStatus: "pending_payment", fulfilmentStatus: "unfulfilled", payableUntil: order.payableUntil.toISOString(), paymentStatuses: [], holdStatus: "active", holdExpiresAt: order.reservation.expiresAt.toISOString(), onHold: false })
    const text = JSON.stringify(found)
    for (const secret of [order.email, "Synthetic Buyer", "12 Fixture Lane", "560034", order.submitKey]) assert.ok(!text.includes(secret), `a case never holds ${secret}`)
    const audit = await ctx.db.auditEvent.findMany({ where: { action: "order.recovery_case_opened", entityId: { in: found.map(c => c.id) } } })
    assert.deepEqual(audit.map(a => [a.actorKind, a.actorId]), [["system", "system:order-reconciliation"], ["system", "system:order-reconciliation"]])
  })

  test("a payment in flight is never guessed: the case says to ask the provider, and the payment stays as it is", async () => {
    const order = await placeOrder()
    const attempt = await payment(order, "authorized")
    const before_ = await world()
    await recovery.reconcileOrders(ctx.db, pastWindow(order))
    assert.equal(await world(), before_)
    assert.equal((await ctx.db.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).status, "authorized")
    const found = await openCases(order.id)
    assert.deepEqual(found.map(c => [c.kind, c.check]), [["hold_overdue", "ask_the_payment_provider_for_the_outcome"], ["pending_past_window", "ask_the_payment_provider_for_the_outcome"]])
    assert.deepEqual(found[0].facts.paymentStatuses, ["authorized"])
  })

  test("a captured payment on an unconfirmed order is surfaced, not confirmed", async () => {
    const order = await placeOrder()
    await payment(order, "captured")
    const before_ = await world()
    await recovery.reconcileOrders(ctx.db, new Date(Date.now() + 16 * MIN))
    assert.equal(await world(), before_)
    assert.ok((await kinds(order.id)).includes("captured_not_confirmed"))
    assert.equal((await ctx.db.order.findUniqueOrThrow({ where: { id: order.id } })).status, "pending_payment")
  })

  test("an order and its hold that disagree: confirmed with stock unallocated, cancelled still holding stock", async () => {
    const confirmed = await placeOrder()
    await force(confirmed.id, { status: "confirmed" })
    const cancelled = await placeOrder()
    await force(cancelled.id, { status: "cancelled" })
    const before_ = await world()
    await recovery.reconcileOrders(ctx.db, new Date(Date.now() + 16 * MIN))
    assert.equal(await world(), before_)
    const check = async id => (await openCases(id)).find(c => c.kind === "hold_mismatch")?.check
    assert.equal(await check(confirmed.id), "confirmed_order_without_allocated_stock")
    assert.equal(await check(cancelled.id), "cancelled_order_still_holds_stock")
  })

  test("an order left in review for a day is surfaced", async () => {
    const order = await placeOrder()
    await force(order.id, { status: "needs_review" })
    await recovery.reconcileOrders(ctx.db, new Date(Date.now() + 23 * 60 * MIN))
    assert.ok(!(await kinds(order.id)).includes("review_waiting"), "not before a day")
    await recovery.reconcileOrders(ctx.db, new Date(Date.now() + 25 * 60 * MIN))
    assert.ok((await kinds(order.id)).includes("review_waiting"))
  })

  test("the worker job runs the same reconciliation on its own clock", async () => {
    const order = await placeOrder()
    const result = await orderReconciliationJob(ctx.db, recovery.reconcileOrders, { clock: () => pastWindow(order) }).run()
    assert.ok(result.checked >= 1 && result.failed === 0, JSON.stringify(result))
    assert.ok((await kinds(order.id)).includes("pending_past_window"))
  })
})

describe("CHV-S13-M14 runs are idempotent, overlap safely, and close cases correctly", () => {
  test("repeated and overlapping runs keep one open case per order and kind, opened and audited once", async () => {
    const order = await placeOrder()
    const now = pastWindow(order)
    await Promise.all([recovery.reconcileOrders(ctx.db, now), recovery.reconcileOrders(ctx.db, now), recovery.reconcileOrders(ctx.db, now)])
    const again = await recovery.reconcileOrders(ctx.db, new Date(now.getTime() + MIN))
    assert.equal(again.failed, 0)
    const found = await openCases(order.id)
    assert.deepEqual(found.map(c => c.kind), ["hold_overdue", "pending_past_window"])
    assert.ok(found.every(c => c.lastSeenAt.getTime() === now.getTime() + MIN), "a later run refreshes the case")
    assert.equal(await ctx.db.auditEvent.count({ where: { action: "order.recovery_case_opened", entityId: { in: found.map(c => c.id) } } }), 2)
    assert.equal(await ctx.db.orderRecoveryCase.count({ where: { orderId: order.id } }), 2, "no duplicates, open or closed")
  })

  test("a case clears when its condition goes: the order was cancelled by the expiry path", async () => {
    const order = await placeOrder()
    const now = pastWindow(order)
    await recovery.reconcileOrders(ctx.db, now)
    const opened = await openCases(order.id)
    assert.equal(opened.length, 2)
    await ctx.db.$transaction(tx => cancel.cancelUnpaidOrder(tx, order.id, { reason: "payment_window_ended", actor: { kind: "system", id: null }, correlationId: randomUUID(), now }))
    await recovery.reconcileOrders(ctx.db, new Date(now.getTime() + MIN))
    assert.deepEqual(await kinds(order.id), [])
    const closed = await ctx.db.orderRecoveryCase.findMany({ where: { id: { in: opened.map(c => c.id) } } })
    assert.ok(closed.every(c => c.status === "cleared" && c.closedBy === null))
    assert.equal(await ctx.db.auditEvent.count({ where: { action: "order.recovery_case_cleared", entityId: { in: opened.map(c => c.id) } } }), 2)
  })

  test("a resolved case does not come back with the same facts, and opens again when something changes", async () => {
    const order = await placeOrder()
    const now = pastWindow(order)
    await recovery.reconcileOrders(ctx.db, now)
    const pending = (await openCases(order.id)).find(c => c.kind === "pending_past_window")
    assert.equal((await resolve(pending.id)).status, 200)
    await recovery.reconcileOrders(ctx.db, new Date(now.getTime() + MIN))
    assert.deepEqual(await kinds(order.id), ["hold_overdue"], "acknowledged, not reopened")
    await payment(order, "created")
    await recovery.reconcileOrders(ctx.db, new Date(now.getTime() + 2 * MIN))
    const reopened = (await openCases(order.id)).find(c => c.kind === "pending_past_window")
    assert.ok(reopened && reopened.id !== pending.id)
    assert.equal(reopened.check, "ask_the_payment_provider_for_the_outcome")
  })

  test("findingsFor is pure: the same order at the same time gives the same findings", async () => {
    const o = { id: randomUUID(), status: "pending_payment", fulfilmentStatus: "unfulfilled", quoteRef: "q", payableUntil: new Date(0), heldAt: null, createdAt: new Date(0), updatedAt: new Date(0), payments: [], reservation: { status: "active", expiresAt: new Date(0) } }
    const now = new Date(16 * MIN)
    assert.deepEqual(recovery.findingsFor(o, now), recovery.findingsFor(o, now))
    assert.deepEqual(recovery.findingsFor(o, new Date(14 * MIN)), [], "not inside the grace period")
    assert.deepEqual(recovery.findingsFor({ ...o, quoteRef: null, reservation: null }, now), [], "an order not placed from a quote has no window or hold to check")
  })
})

describe("CHV-S13-M14 staff see and resolve cases; resolving changes nothing on the order", () => {
  test("visitors 401, customers 403; staff list; only admins and owners resolve; cross-site refused", async () => {
    const order = await placeOrder()
    await recovery.reconcileOrders(ctx.db, pastWindow(order))
    const [one] = await openCases(order.id)
    assert.equal((await cases("", { jar: null })).status, 401)
    assert.equal((await cases("", { jar: customer })).status, 403)
    const listed = await cases(`?orderId=${order.id}`)
    assert.equal(listed.status, 200)
    assert.equal(listed.response.headers.get("cache-control"), "no-store")
    assert.deepEqual(listed.json.data.map(c => [c.orderNumber, c.status]).sort(), [[order.number, "open"], [order.number, "open"]])
    assert.equal((await resolve(one.id, { jar: null })).status, 401)
    assert.equal((await resolve(one.id, { jar: customer })).status, 403)
    assert.equal((await resolve(one.id, { jar: staff.jar })).status, 403, "STAFF cannot resolve")
    const x = await resolve(one.id, { origin: "https://evil.example" })
    assert.deepEqual([x.status, x.json.error], [403, "cross_site"])
    assert.equal((await ctx.db.orderRecoveryCase.findUniqueOrThrow({ where: { id: one.id } })).status, "open")
  })

  test("resolving needs a reason, is audited, is refused the second time, and leaves the order alone", async () => {
    const order = await placeOrder()
    await recovery.reconcileOrders(ctx.db, pastWindow(order))
    const [one] = await openCases(order.id)
    assert.equal((await resolve(one.id, { reason: "x" })).status, 400)
    const before_ = await world()
    const res = await resolve(one.id)
    assert.equal(res.status, 200, JSON.stringify(res.json))
    assert.deepEqual([res.json.data.status, res.json.data.closedBy, res.json.data.resolution], ["resolved", owner.user.id, "checked with the courier, nothing to do"])
    assert.equal(await world(), before_, "resolving changes no order, payment, hold, movement or event")
    assert.equal((await resolve(one.id)).status, 409, "already resolved")
    assert.equal((await resolve(randomUUID())).status, 404)
    const audits = await ctx.db.auditEvent.findMany({ where: { action: "order.recovery_case_resolved", entityId: one.id } })
    assert.deepEqual(audits.map(a => [a.actorKind, a.actorId, a.reason]), [["staff", owner.user.id, "checked with the courier, nothing to do"]])
    const view = (await call(forward(), `/api/admin/orders/${order.id}`, { jar: staff.jar, ip: newIp() })).json.data
    assert.deepEqual(view.recoveryCases.map(c => c.status).sort(), ["open", "resolved"])
  })

  test("the routes declare their capabilities, and bad filters are refused", async () => {
    const { OrderRecoveryController } = await apiModule("modules/order-recovery.controller")
    const rule = name => Reflect.getMetadata("chaanavya:access", OrderRecoveryController.prototype[name])
    assert.deepEqual([rule("list"), rule("resolve")], [{ kind: "permission", capability: "orders.read" }, { kind: "permission", capability: "orders.manage" }])
    for (const q of ["?status=closed", "?kind=lost", "?orderId=1%20OR%201", "?limit=0", "?cursor=%25%25"]) assert.equal((await cases(q)).status, 400, q)
    assert.equal((await cases("?status=resolved")).status, 200)
  })

  test("the database keeps cases honest: closed cases do not change, nothing is deleted, facts carry nothing personal", async () => {
    const order = await placeOrder()
    await recovery.reconcileOrders(ctx.db, pastWindow(order))
    const [one, two] = await openCases(order.id)
    await resolve(one.id)
    await assert.rejects(ctx.db.orderRecoveryCase.update({ where: { id: one.id }, data: { status: "open", closedAt: null, closedBy: null, resolution: null } }), /cannot change/)
    await assert.rejects(ctx.db.orderRecoveryCase.delete({ where: { id: two.id } }), /kept/)
    await assert.rejects(ctx.db.orderRecoveryCase.create({ data: { orderId: order.id, kind: "review_waiting", facts: { email: "someone@example.com" }, factsKey: "0".repeat(64), check: "review_the_order" } }), /facts_redacted/)
    await assert.rejects(ctx.db.orderRecoveryCase.create({ data: { orderId: order.id, kind: two.kind, facts: {}, factsKey: "0".repeat(64), check: "x" } }), /Unique constraint|one_open/, "one open case per order and kind")
  })
})
