// CHV-S14-M03: one logical payment attempt has a stable identity (apps/api/src/payments/attempts.ts, migration
// 20261031000000_payment_attempt_identity). An attempt records the order's own total in INR, the order, the
// provider and mode, its state, its idempotency key and, once known, the provider's references. Opening it
// again, with the same key, another key, or many requests at once, gives the same attempt; its identity and
// provider references cannot be rewritten, by the service or directly in the database. Orders are placed
// through the web host's forwarder. Tax values are synthetic test values; delivery is the sandbox courier.
import { after, before, describe, test } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { apiModule, call, createStaff, Jar, newIp, setup, withOrigin } from "../auth/helpers.mjs"

let ctx, forward, attempts, transitions, owner
let n = 0

const cart = (method, path, { jar, body, headers = {} } = {}) => call(forward, `/api/cart${path}`, { method, jar, body, headers, ip: newIp() })
const address = { name: "Synthetic Buyer", phone: "+91 60000 00000", line1: "1 Example Road", line2: null, landmark: null, city: "Bengaluru", district: "Bengaluru Urban", stateCode: "IN-KA", pinCode: "560034" }
const RAZORPAY = { kind: "provider", id: "razorpay" }

/** A pending order for one item, placed by a guest. */
async function placed() {
  n += 1
  const p = await ctx.db.product.create({
    data: { handle: `fixture-attempt-${n}`, title: `Fixture attempt ${n}`, status: "active", publishedAt: new Date(), shippingRestriction: "none", variants: { create: [{ sku: `fixture-attempt-${n}-m`, title: "M", optionKey: "size:m", pricePaise: 249900n, taxCategory: "apparel_cotton", weightGrams: 300 }] } },
    include: { variants: true },
  })
  await ctx.db.inventoryBalance.create({ data: { variantId: p.variants[0].id, onHand: 5, lastCountedAt: new Date() } })
  const jar = new Jar()
  assert.equal((await cart("POST", "/lines", { jar, body: { variantId: p.variants[0].id, quantity: 1 }, headers: { "idempotency-key": randomUUID() } })).status, 200)
  assert.equal((await cart("PUT", "/contact", { jar, body: { email: "buyer@example.com", shippingAddress: address } })).status, 200)
  const quote = (await cart("POST", "/quote", { jar, body: {} })).json.data
  const res = await cart("POST", "/order", { jar, body: { quoteId: quote.id, expectedGrandTotal: quote.grandTotal }, headers: { "idempotency-key": randomUUID() } })
  assert.equal(res.status, 201, JSON.stringify(res.json))
  return ctx.db.order.findUniqueOrThrow({ where: { id: res.json.data.id } })
}

const open = (order, key = `key-${randomUUID()}`, extra = {}) => attempts.openAttempt(ctx.db, { orderId: order.id, provider: "razorpay", mode: "test", key, ...extra })
const rows = orderId => ctx.db.paymentAttempt.findMany({ where: { orderId }, orderBy: { createdAt: "asc" } })
const fails = status => e => e.status === status
const move = (a, from, to) => ctx.db.$transaction(tx => transitions.transitionPayment(tx, { paymentAttemptId: a.id, from, to, facts: {}, actor: RAZORPAY, correlationId: randomUUID() }))

before(async () => {
  ctx = await setup("chaanavya_test_s14_attempts")
  forward = ctx.routes.me.GET
  attempts = await apiModule("payments/attempts")
  transitions = await apiModule("db/transitions")
  owner = (await createStaff(ctx, "s14.attempts.owner@example.com", "OWNER")).user
  await ctx.db.taxProfile.create({ data: { sellerStateCode: "IN-KA", pricesIncludeTax: true, note: "synthetic test values", createdById: owner.id, rates: { create: [{ taxCategory: "apparel_cotton", hsnCode: "6204", rateBasisPoints: 500 }] } } })
})
after(() => ctx?.teardown())

describe("CHV-S14-M03 an attempt records what it pays for", () => {
  test("opening records the order's own total in INR, the order, provider, mode, state and key; the provider refs come later", async () => {
    const order = await placed()
    const { attempt, reused } = await open(order, "checkout-key-0001")
    assert.equal(reused, false)
    assert.deepEqual(
      [attempt.orderId, attempt.provider, attempt.mode, attempt.amount, attempt.status, attempt.providerOrderId, attempt.providerPaymentId],
      [order.id, "razorpay", "test", { amountPaise: Number(order.grandTotalPaise), currency: "INR" }, "created", null, null],
    )
    const [row] = await rows(order.id)
    assert.equal(row.idempotencyKey, `order:${order.id}:checkout-key-0001`, "the key is stored scoped to its order")
    assert.equal(row.amountPaise, order.grandTotalPaise)
  })
})

describe("CHV-S14-M03 one logical attempt has a stable identity", () => {
  test("the same key, another key, or a second tab all get the same attempt", async () => {
    const order = await placed()
    const first = await open(order, "checkout-key-0002")
    const again = await open(order, "checkout-key-0002")
    const otherTab = await open(order, "checkout-key-0003")
    assert.deepEqual([again.attempt.id, again.reused, otherTab.attempt.id, otherTab.reused], [first.attempt.id, true, first.attempt.id, true])
    assert.equal((await rows(order.id)).length, 1)
  })

  test("twelve simultaneous opens with mixed keys create one attempt, and every caller gets it", async () => {
    const order = await placed()
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => open(order, `race-key-${i % 3}-${order.id.slice(0, 8)}`)))
    assert.equal(new Set(results.map(r => r.attempt.id)).size, 1)
    assert.equal(results.filter(r => !r.reused).length, 1, "exactly one created it")
    assert.equal((await rows(order.id)).length, 1)
  })

  test("a key is scoped to its order: the same key on another order is a different attempt", async () => {
    const [a, b] = [await placed(), await placed()]
    const first = await open(a, "shared-key-0001")
    const second = await open(b, "shared-key-0001")
    assert.notEqual(first.attempt.id, second.attempt.id)
    assert.equal(second.attempt.orderId, b.id)
  })

  test("only after an attempt ends can a new one start, with its own identity; the old one stays", async () => {
    const order = await placed()
    const first = (await open(order, "first-key-0001")).attempt
    assert.equal(await move(first, "created", "failed"), "applied")
    const second = await open(order, "second-key-0001")
    assert.equal(second.reused, false)
    assert.notEqual(second.attempt.id, first.id)
    // The first key still finds the first attempt, ended as it is: a retry never resurrects or repoints it.
    const retried = await open(order, "first-key-0001")
    assert.deepEqual([retried.attempt.id, retried.attempt.status], [first.id, "failed"])
    assert.deepEqual((await rows(order.id)).map(r => r.status), ["failed", "created"])
  })

  test("refused, with nothing written: a bad key, a provider not switched on, a closed order, an ended window, an unknown order", async () => {
    const order = await placed()
    for (const key of ["short", "has spaces in it", "x".repeat(101)]) await assert.rejects(open(order, key), fails(400), key)
    for (const provider of ["phonepe", "stripe"]) await assert.rejects(open(order, undefined, { provider }), fails(409), provider)
    await assert.rejects(open(order, undefined, { now: new Date(order.payableUntil.getTime() + 1000) }), fails(409), "window ended")
    await assert.rejects(open({ id: randomUUID() }), fails(404))
    assert.equal((await rows(order.id)).length, 0)
    const closed = await placed()
    await withOrigin(ctx.db, tx => tx.order.update({ where: { id: closed.id }, data: { status: "cancelled" } }))
    await assert.rejects(open(closed), fails(409))
    assert.equal((await rows(closed.id)).length, 0)
  })

  test("the provider's checkout reference is written once: the same again is a no-op, a different one is refused", async () => {
    const order = await placed()
    const { attempt } = await open(order)
    assert.equal((await attempts.recordProviderOrderRef(ctx.db, attempt.id, "provider_ref_A")).providerOrderId, "provider_ref_A")
    assert.equal((await attempts.recordProviderOrderRef(ctx.db, attempt.id, "provider_ref_A")).providerOrderId, "provider_ref_A")
    await assert.rejects(attempts.recordProviderOrderRef(ctx.db, attempt.id, "provider_ref_B"), fails(409))
    await assert.rejects(attempts.recordProviderOrderRef(ctx.db, randomUUID(), "provider_ref_C"), fails(404))
    assert.equal((await rows(order.id))[0].providerOrderId, "provider_ref_A")
  })
})

describe("CHV-S14-M03 the database keeps the identity, whoever writes", () => {
  test("an attempt's order, provider, mode, amount, currency, key and creation time cannot change, and it cannot be deleted", async () => {
    const [order, other] = [await placed(), await placed()]
    const { attempt } = await open(order)
    for (const data of [{ orderId: other.id }, { provider: "phonepe" }, { mode: "live" }, { amountPaise: 1n }, { currency: "USD" }, { idempotencyKey: "order:else:key" }, { createdAt: new Date(0) }]) {
      await assert.rejects(ctx.db.paymentAttempt.update({ where: { id: attempt.id }, data }), JSON.stringify(data, (_, v) => (typeof v === "bigint" ? String(v) : v)))
    }
    await assert.rejects(ctx.db.paymentAttempt.delete({ where: { id: attempt.id } }), /kept/)
    const [row] = await rows(order.id)
    assert.deepEqual([row.orderId, row.provider, row.mode, row.amountPaise, row.currency], [order.id, "razorpay", "test", order.grandTotalPaise, "INR"])
  })

  test("provider references are set once in the database too; the state still moves through its machine", async () => {
    const order = await placed()
    const { attempt } = await open(order)
    await ctx.db.paymentAttempt.update({ where: { id: attempt.id }, data: { providerOrderId: "provider_ref_X", providerPaymentId: "provider_pay_X" } })
    await assert.rejects(ctx.db.paymentAttempt.update({ where: { id: attempt.id }, data: { providerOrderId: "provider_ref_Y" } }), /set once/)
    await assert.rejects(ctx.db.paymentAttempt.update({ where: { id: attempt.id }, data: { providerPaymentId: "provider_pay_Y" } }), /set once/)
    await assert.rejects(ctx.db.paymentAttempt.update({ where: { id: attempt.id }, data: { providerPaymentId: null } }), /set once/)
    assert.equal(await move(attempt, "created", "authorized"), "applied", "identity rules never block a valid state move")
    assert.deepEqual(await ctx.db.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id }, select: { providerOrderId: true, providerPaymentId: true, status: true } }), { providerOrderId: "provider_ref_X", providerPaymentId: "provider_pay_X", status: "authorized" })
  })

  test("a direct insert must ask for the order's total in INR, and a second attempt in progress is refused", async () => {
    const order = await placed()
    const base = { orderId: order.id, provider: "razorpay", mode: "test", amountPaise: order.grandTotalPaise }
    await assert.rejects(ctx.db.paymentAttempt.create({ data: { ...base, amountPaise: order.grandTotalPaise - 1n, idempotencyKey: randomUUID() } }), /order's total/)
    await assert.rejects(ctx.db.paymentAttempt.create({ data: { ...base, currency: "USD", idempotencyKey: randomUUID() } }))
    await assert.rejects(ctx.db.paymentAttempt.create({ data: { ...base, idempotencyKey: "  " } }))
    await ctx.db.paymentAttempt.create({ data: { ...base, idempotencyKey: randomUUID() } })
    for (const status of ["created", "authorized", "pending_reconciliation"]) {
      await assert.rejects(ctx.db.paymentAttempt.create({ data: { ...base, status, idempotencyKey: randomUUID() } }), /Unique constraint|one_open_per_order/, status)
    }
    // Ended attempts do not count: a failed one may sit beside the one in progress.
    await ctx.db.paymentAttempt.create({ data: { ...base, status: "failed", idempotencyKey: randomUUID() } })
    assert.equal((await rows(order.id)).length, 2)
  })
})
