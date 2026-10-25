// CHV-S11-M09: the promotion validity engine (apps/api/src/promotions) rejects expired, not yet
// started, switched-off, unknown and ineligible codes, and computes the discount on the server in
// whole paise, never more than the subtotal. Per-customer limits count by account for customers and
// by guest session for guests (owner decision, 25 October 2026). The pure rules are tested directly;
// the database path (code lookup, usage from orders) runs against a throwaway database.
import { after, before, describe, test } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { apiModule, orderData, setup } from "../auth/helpers.mjs"

let ctx, engine, check
const DAY = 86_400_000
const NOW = new Date("2026-10-25T12:00:00.000Z")

/** A promotion record as the engine sees it; every field can be overridden. */
const promo = (overrides = {}) => ({
  id: randomUUID(),
  code: "FESTIVE10",
  kind: "percent",
  percentBasisPoints: 1000,
  amountOffPaise: null,
  minSubtotalPaise: null,
  currency: "INR",
  startsAt: new Date(NOW.getTime() - DAY),
  endsAt: new Date(NOW.getTime() + DAY),
  usageLimit: null,
  perCustomerLimit: null,
  usageCount: 0,
  active: true,
  ...overrides,
})
const shopper = (used = 0) => ({ usedByThisShopper: used })
const decide = (p, { subtotalPaise = 500000, used = 0, now = NOW, currency = "INR" } = {}) => engine.evaluatePromotion(p, { now, subtotalPaise, currency, shopper: shopper(used) })
const reason = (...args) => decide(...args).reason

before(async () => {
  ctx = await setup("chaanavya_test_s11_promotions")
  engine = await apiModule("promotions/validity")
  check = await apiModule("promotions/check")
})
after(() => ctx?.teardown())

describe("CHV-S11-M09 promotion validity", () => {
  test("an expired code is rejected, from the exact end time on", () => {
    const p = promo({ endsAt: NOW })
    assert.equal(reason(p), "expired", "ends_at is exclusive")
    assert.equal(reason(p, { now: new Date(NOW.getTime() + 365 * DAY) }), "expired")
    assert.equal(decide(p, { now: new Date(NOW.getTime() - 1) }).ok, true, "one millisecond before the end it still works")
  })

  test("a code that has not started is rejected until its start time", () => {
    const p = promo({ startsAt: new Date(NOW.getTime() + 1) })
    assert.equal(reason(p), "not_started")
    assert.equal(decide(p, { now: new Date(NOW.getTime() + 1) }).ok, true, "starts_at is inclusive")
  })

  test("a switched-off or unknown code reads as not found", () => {
    assert.equal(reason(promo({ active: false })), "not_found")
    assert.equal(reason(null), "not_found")
  })

  test("ineligible shoppers and bags are rejected", () => {
    assert.equal(reason(promo({ minSubtotalPaise: 500001 })), "minimum_not_met")
    assert.equal(decide(promo({ minSubtotalPaise: 500000 })).ok, true, "exactly the minimum qualifies")
    assert.equal(reason(promo(), { subtotalPaise: 0 }), "minimum_not_met", "an empty bag never qualifies")
    assert.equal(reason(promo({ usageLimit: 100, usageCount: 100 })), "usage_limit_reached")
    assert.equal(decide(promo({ usageLimit: 100, usageCount: 99 })).ok, true)
    assert.equal(reason(promo({ perCustomerLimit: 1 }), { used: 1 }), "per_customer_limit_reached")
    assert.equal(reason(promo({ perCustomerLimit: 2 }), { used: 3 }), "per_customer_limit_reached")
    assert.equal(decide(promo({ perCustomerLimit: 2 }), { used: 1 }).ok, true, "below the limit")
    assert.equal(reason(promo({ currency: "USD" })), "currency_mismatch")
  })

  test("the discount is computed on the server in whole paise and never exceeds the subtotal", () => {
    assert.deepEqual(decide(promo(), { subtotalPaise: 249999 }).discountPaise, 24999, "10% of 2,499.99 rounds down to 249.99")
    assert.equal(decide(promo({ percentBasisPoints: 10000 }), { subtotalPaise: 123456 }).discountPaise, 123456, "100% is the whole subtotal")
    assert.equal(decide(promo({ percentBasisPoints: 1 }), { subtotalPaise: 9999 }).ok, false, "a discount that rounds to nothing is refused")
    const fixed = promo({ kind: "fixed_amount", percentBasisPoints: null, amountOffPaise: 50000 })
    assert.equal(decide(fixed, { subtotalPaise: 200000 }).discountPaise, 50000)
    assert.equal(decide(fixed, { subtotalPaise: 30000 }).discountPaise, 30000, "capped at the subtotal")
    for (let s = 1; s < 300000; s += 7919) {
      for (const p of [promo({ percentBasisPoints: 3333 }), fixed]) {
        const d = decide(p, { subtotalPaise: s })
        if (d.ok) assert.ok(Number.isInteger(d.discountPaise) && d.discountPaise > 0 && d.discountPaise <= s, `${s}: ${d.discountPaise}`)
      }
    }
    assert.throws(() => decide(promo(), { subtotalPaise: 100.5 }), /whole paise/)
    assert.throws(() => decide(promo(), { subtotalPaise: -1 }), /whole paise/)
  })

  test("codes are normalised; anything that cannot be a code is not found", () => {
    assert.equal(engine.normaliseCode("  festive10 "), "FESTIVE10")
    for (const raw of ["", "ab", "x".repeat(33), "FEST IVE", "FESTIVE10'--", "FESTIVE%", 10, null, ["FESTIVE10"], { code: "FESTIVE10" }]) assert.equal(engine.normaliseCode(raw), null, JSON.stringify(raw))
  })

  test("database path: real codes are found case-insensitively and the same rules apply", async () => {
    const base = { kind: "percent", percentBasisPoints: 1500, startsAt: new Date(Date.now() - DAY), endsAt: new Date(Date.now() + DAY), active: true }
    await ctx.db.promotion.createMany({
      data: [
        { code: "LIVE15", ...base },
        { code: "OLD15", ...base, startsAt: new Date(Date.now() - 10 * DAY), endsAt: new Date(Date.now() - DAY) },
        { code: "SOON15", ...base, startsAt: new Date(Date.now() + DAY), endsAt: new Date(Date.now() + 2 * DAY) },
        { code: "DRAFT15", ...base, active: false },
        { code: "BIGBAG", kind: "fixed_amount", amountOffPaise: 100000n, minSubtotalPaise: 1000000n, startsAt: base.startsAt, active: true },
        { code: "SPENT", ...base, usageLimit: 5, usageCount: 5 },
      ],
    })
    const run = (code, extra = {}) => check.checkPromotion(ctx.db, { code, owner: { kind: "guest", guestSessionId: randomUUID() }, subtotalPaise: 400000, ...extra })
    assert.deepEqual(await run(" live15 "), { ok: true, promotionId: (await ctx.db.promotion.findUniqueOrThrow({ where: { code: "LIVE15" } })).id, code: "LIVE15", discountPaise: 60000 })
    assert.equal((await run("OLD15")).reason, "expired")
    assert.equal((await run("SOON15")).reason, "not_started")
    assert.equal((await run("DRAFT15")).reason, "not_found")
    assert.equal((await run("NOSUCHCODE")).reason, "not_found")
    assert.equal((await run("live15' OR '1'='1")).reason, "not_found")
    assert.equal((await run("BIGBAG")).reason, "minimum_not_met")
    assert.equal((await run("BIGBAG", { subtotalPaise: 1000000 })).discountPaise, 100000)
    assert.equal((await run("SPENT")).reason, "usage_limit_reached")
  })

  test("database path: a per-customer limit counts the shopper's orders with the code (by account, or by guest session), except cancelled ones", async () => {
    const p = await ctx.db.promotion.create({ data: { code: "ONCEEACH", kind: "percent", percentBasisPoints: 1000, startsAt: new Date(Date.now() - DAY), perCustomerLimit: 1, active: true } })
    const users = await Promise.all(["promo.a@example.com", "promo.b@example.com"].map(email => ctx.db.user.create({ data: { email, emailVerified: true } })))
    const [a, b] = users.map(u => ({ kind: "customer", customerId: u.id }))
    const run = owner => check.checkPromotion(ctx.db, { code: "onceeach", owner, subtotalPaise: 300000 })
    assert.equal((await run(a)).ok, true, "unused")
    await ctx.db.order.create({ data: orderData({ email: "promo.a@example.com", userId: users[0].id, promotionId: p.id, status: "cancelled" }) })
    assert.equal((await run(a)).ok, true, "a cancelled order does not count")
    await ctx.db.order.create({ data: orderData({ email: "promo.a@example.com", userId: users[0].id, promotionId: p.id, status: "pending_payment" }) })
    assert.equal((await run(a)).reason, "per_customer_limit_reached", "an order awaiting payment counts, so parallel checkouts cannot exceed the limit")
    assert.equal((await run(b)).ok, true, "another customer is unaffected")
    // Guests may use the code too; their limit is counted against their own guest session.
    const { session } = await ctx.guest.createGuestSession(ctx.db)
    const guest = { kind: "guest", guestSessionId: session.id }
    assert.equal((await run(guest)).ok, true, "a guest with no orders")
    await ctx.db.order.create({ data: orderData({ email: "promo.guest@example.com", guestSessionId: session.id, promotionId: p.id, status: "confirmed" }) })
    assert.equal((await run(guest)).reason, "per_customer_limit_reached", "the guest session's own order counts")
    assert.equal((await run({ kind: "guest", guestSessionId: randomUUID() })).ok, true, "another guest session is unaffected")
    assert.equal((await run(a)).reason, "per_customer_limit_reached", "a guest order does not reset a customer's count")
    assert.equal((await run(null)).ok, true, "no session: no orders yet")
  })

  test("the database refuses promotion rows the engine could not price safely", async () => {
    const at = { startsAt: new Date(Date.now() - DAY), active: true }
    const bad = [
      { code: "lower", kind: "percent", percentBasisPoints: 1000, ...at },
      { code: "BOTH", kind: "percent", percentBasisPoints: 1000, amountOffPaise: 100n, ...at },
      { code: "OVER100", kind: "percent", percentBasisPoints: 10001, ...at },
      { code: "ZEROFIXED", kind: "fixed_amount", amountOffPaise: 0n, ...at },
      { code: "BACKWARDS", kind: "percent", percentBasisPoints: 1000, startsAt: new Date(), endsAt: new Date(Date.now() - DAY), active: true },
      { code: "NEGLIMIT", kind: "percent", percentBasisPoints: 1000, usageLimit: 0, ...at },
    ]
    for (const data of bad) await assert.rejects(ctx.db.promotion.create({ data }), /check constraint|violates/i, data.code)
  })
})
