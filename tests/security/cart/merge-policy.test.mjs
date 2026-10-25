// CHV-S11-M07: the guest-to-customer merge policy (apps/api/src/cart/merge.ts) is deterministic and
// follows the owner's decisions of 25 October 2026: the larger quantity for the same item, unavailable
// items brought over (flagged by the bag), account items first under the line limit with the newest
// guest items filling the room, and nothing about ownership or price in the plan. Pure function: no
// database is needed (the API is built first by `npm run test:security`).
import { before, describe, test } from "node:test"
import assert from "node:assert/strict"
import { apiModule } from "../auth/helpers.mjs"

let planMerge, LIMITS
before(async () => {
  ;({ planMerge } = await apiModule("cart/merge"))
  ;({ CART_LIMITS: LIMITS } = await apiModule("cart/cart"))
})

const T0 = Date.parse("2026-10-25T10:00:00.000Z")
let n = 0
/** A cart line; `at` is minutes after T0. */
const line = (variant, quantity, at = 0, id = `00000000-0000-7000-8000-${String(++n).padStart(12, "0")}`) => ({ id, variantId: `v-${variant}`, quantity, createdAt: new Date(T0 + at * 60_000) })
const quantities = plan => Object.fromEntries(plan.lines.map(l => [l.variantId, l.quantity]))

/** Small seeded generator, so the "random" cases are the same on every run. */
function rng(seed) {
  let s = seed >>> 0
  return () => ((s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x9e3779b9) >>> 0) / 2 ** 32)
}
const shuffle = (items, random) => {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

describe("CHV-S11-M07 guest-to-customer merge policy", () => {
  test("the same item keeps the larger quantity, from whichever side", () => {
    const plan = planMerge([line("a", 1), line("b", 4), line("c", 2)], [line("a", 2), line("b", 3), line("c", 2)])
    assert.deepEqual(quantities(plan), { "v-a": 2, "v-b": 4, "v-c": 2 })
    assert.deepEqual(Object.fromEntries(plan.lines.map(l => [l.variantId, l.source])), { "v-a": "guest", "v-b": "account", "v-c": "both" })
    assert.equal(plan.changesAccount, true, "a grew")
  })

  test("quantities stay within 1 to the per-line limit", () => {
    const plan = planMerge([line("a", 3)], [line("a", 25), line("b", 99), line("c", 0)])
    assert.equal(LIMITS.maxQuantity, 10)
    assert.deepEqual(quantities(plan), { "v-a": 10, "v-b": 10, "v-c": 1 })
  })

  test("guest items for new variants are added after the account's, newest first", () => {
    const plan = planMerge([line("acc1", 1, 0), line("acc2", 1, 5)], [line("old", 1, 1), line("new", 1, 9), line("mid", 1, 4)])
    assert.deepEqual(plan.lines.map(l => l.variantId), ["v-acc1", "v-acc2", "v-new", "v-mid", "v-old"])
  })

  test("unavailable guest items are brought over like any other line (the bag flags them)", () => {
    // The policy has no availability input on purpose: what is off sale or out of stock is shown
    // flagged by the bag, and the shopper decides. Every guest variant is merged while there is room.
    const plan = planMerge([], [line("off-sale", 2, 1), line("sold-out", 1, 2)])
    assert.deepEqual(quantities(plan), { "v-off-sale": 2, "v-sold-out": 1 })
    assert.deepEqual(plan.leftBehind, [])
  })

  test("under the line limit, every account line stays and the newest guest items fill the room", () => {
    const account = Array.from({ length: LIMITS.maxLines - 2 }, (_, i) => line(`acc${i}`, 1, i))
    const guest = [line("g1", 1, 100), line("g2", 2, 300), line("g3", 3, 200), line("g4", 4, 50), line(`acc0`, 5, 400)]
    const plan = planMerge(account, guest)
    assert.equal(plan.lines.length, LIMITS.maxLines)
    for (const a of account) assert.ok(plan.lines.some(l => l.variantId === a.variantId), `kept ${a.variantId}`)
    assert.equal(quantities(plan)["v-acc0"], 5, "a duplicate is not a new line, so it is merged even when the bag is full")
    assert.deepEqual(plan.lines.slice(-2).map(l => l.variantId), ["v-g2", "v-g3"], "the two newest new items")
    assert.deepEqual(plan.leftBehind, [{ variantId: "v-g1", quantity: 1 }, { variantId: "v-g4", quantity: 4 }])
  })

  test("a full account bag keeps all its lines and leaves every new guest item behind", () => {
    const account = Array.from({ length: LIMITS.maxLines }, (_, i) => line(`acc${i}`, 1, i))
    const plan = planMerge(account, [line("x", 1, 1), line("y", 1, 2)])
    assert.equal(plan.lines.length, LIMITS.maxLines)
    assert.deepEqual(plan.leftBehind.map(l => l.variantId), ["v-y", "v-x"])
    assert.equal(plan.changesAccount, false)
  })

  test("an empty guest bag, or one already covered, changes nothing", () => {
    const account = [line("a", 3), line("b", 1)]
    for (const guest of [[], [line("a", 2), line("b", 1)]]) {
      const plan = planMerge(account, guest)
      assert.equal(plan.changesAccount, false)
      assert.deepEqual(quantities(plan), { "v-a": 3, "v-b": 1 })
    }
  })

  test("merging the same guest bag twice gives the same bag (no doubling)", () => {
    const account = [line("a", 1), line("b", 2)]
    const guest = [line("a", 3, 1), line("c", 2, 2)]
    const once = planMerge(account, guest)
    const asLines = once.lines.map((l, i) => line(l.variantId.slice(2), l.quantity, i))
    const twice = planMerge(asLines, guest)
    assert.deepEqual(quantities(twice), quantities(once))
    assert.equal(twice.changesAccount, false)
  })

  test("deterministic: the input order never changes the result, and creation-time ties fall back to the line id", () => {
    const random = rng(1107)
    const account = [line("a", 2, 3), line("b", 1, 1), line("c", 5, 2)]
    const guest = [line("a", 4, 7), line("d", 1, 5, "00000000-0000-7000-8000-00000000000b"), line("e", 2, 5, "00000000-0000-7000-8000-00000000000a"), line("f", 3, 6)]
    const expected = planMerge(account, guest, { maxQuantity: 10, maxLines: 5 })
    assert.deepEqual(expected.lines.slice(3).map(l => l.variantId), ["v-f", "v-e"], "same time: the lower id first")
    for (let i = 0; i < 50; i++) assert.deepEqual(planMerge(shuffle(account, random), shuffle(guest, random), { maxQuantity: 10, maxLines: 5 }), expected)
  })

  test("the plan says nothing about owners, carts or prices: only variants and quantities move", () => {
    const plan = planMerge([line("a", 1)], [{ ...line("b", 2), cartId: "guest-cart", guestSessionId: "guest-session", unitPrice: 1, pricePaise: 1 }])
    const text = JSON.stringify(plan)
    for (const forbidden of ["guest-cart", "guest-session", "cartId", "guestSessionId", "userId", "price", "Paise"]) assert.ok(!text.includes(forbidden), forbidden)
    for (const l of plan.lines) assert.deepEqual(Object.keys(l).sort(), ["quantity", "source", "variantId"])
  })

  test("300 seeded random bags: every rule holds every time", () => {
    const random = rng(20261025)
    for (let round = 0; round < 300; round++) {
      const pick = count => shuffle(Array.from({ length: 40 }, (_, i) => `p${i}`), random).slice(0, count)
      const account = pick(Math.floor(random() * 31)).map((v, i) => line(v, 1 + Math.floor(random() * 10), Math.floor(random() * 50), `00000000-0000-7000-8000-a${String(round * 100 + i).padStart(11, "0")}`))
      const guest = pick(Math.floor(random() * 31)).map((v, i) => line(v, 1 + Math.floor(random() * 10), Math.floor(random() * 50), `00000000-0000-7000-8000-b${String(round * 100 + i).padStart(11, "0")}`))
      const plan = planMerge(account, guest)
      const q = quantities(plan)
      assert.equal(new Set(plan.lines.map(l => l.variantId)).size, plan.lines.length, "one line per variant")
      assert.ok(plan.lines.length <= Math.max(LIMITS.maxLines, account.length))
      for (const l of plan.lines) assert.ok(l.quantity >= 1 && l.quantity <= LIMITS.maxQuantity)
      for (const a of account) {
        const g = guest.find(x => x.variantId === a.variantId)
        assert.equal(q[a.variantId], Math.max(a.quantity, g?.quantity ?? 0), "account lines stay, larger quantity wins")
      }
      for (const g of guest) assert.ok(g.variantId in q || plan.leftBehind.some(l => l.variantId === g.variantId), "every guest item is merged or reported")
      assert.deepEqual(planMerge(shuffle(account, random), shuffle(guest, random)), plan, "same result for shuffled input")
    }
  })
})
