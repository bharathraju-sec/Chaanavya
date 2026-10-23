// CHV-S02-002: frontend price edits do not change the server-accepted amount.
// Plus the no-overselling invariant (reference semantics for Stage 08).
import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { availableUnits, computeGrandTotal, matchesServerAmount, priceLines, reserveAll } from "../../packages/contracts/src/modules/invariants.ts"

// Synthetic fixtures only: not real merchandise or prices.
const catalogue = new Map([
  ["variant-a", { unitPricePaise: 349_900, sellable: true }],
  ["variant-b", { unitPricePaise: 179_900, sellable: true }],
  ["variant-hidden", { unitPricePaise: 10_000, sellable: false }],
])

const honest = [
  { variantId: "variant-a", quantity: 2 },
  { variantId: "variant-b", quantity: 1 },
]

describe("CHV-S02-002 server-set prices", () => {
  test("honest request is priced from the catalogue", () => {
    const priced = priceLines(honest, catalogue)
    assert.ok(priced.ok)
    assert.equal(priced.value.subtotalPaise, 2 * 349_900 + 179_900)
  })

  test("client-supplied prices, totals and currency are ignored", () => {
    const tampered = [
      { variantId: "variant-a", quantity: 2, unitPrice: { amountPaise: 1, currency: "INR" }, price: "1.00", lineTotal: 2 },
      { variantId: "variant-b", quantity: 1, unitPricePaise: 0, discount: 179_900, currency: "USD" },
    ]
    const honestResult = priceLines(honest, catalogue)
    const tamperedResult = priceLines(tampered, catalogue)
    assert.ok(honestResult.ok && tamperedResult.ok)
    assert.deepEqual(tamperedResult.value, honestResult.value)
  })

  test("client echo of a lower total is rejected, never adopted", () => {
    const priced = priceLines(honest, catalogue)
    assert.ok(priced.ok)
    const total = computeGrandTotal({ subtotalPaise: priced.value.subtotalPaise, discountPaise: 0, shippingFeePaise: 0, taxPaise: 0, pricesIncludeTax: true })
    assert.ok(total.ok)
    const server = { amountPaise: total.value, currency: "INR" }
    assert.equal(matchesServerAmount({ amountPaise: total.value, currency: "INR" }, server), true)
    assert.equal(matchesServerAmount({ amountPaise: total.value - 1, currency: "INR" }, server), false)
    assert.equal(matchesServerAmount({ amountPaise: String(total.value), currency: "INR" }, server), false)
    assert.equal(matchesServerAmount({ amountPaise: total.value, currency: "USD" }, server), false)
    assert.equal(matchesServerAmount(null, server), false)
  })

  test("invalid quantities, unknown or unsellable variants and duplicates are refused", () => {
    for (const bad of [[], [{ variantId: "variant-a", quantity: 0 }], [{ variantId: "variant-a", quantity: 1.5 }], [{ variantId: "variant-a", quantity: 100 }], [{ variantId: "nope", quantity: 1 }], [{ variantId: "variant-hidden", quantity: 1 }], [honest[0], honest[0]], "variant-a", null]) {
      assert.equal(priceLines(bad, catalogue).ok, false, JSON.stringify(bad))
    }
  })

  test("money stays in integer paise", () => {
    assert.equal(computeGrandTotal({ subtotalPaise: 100.5, discountPaise: 0, shippingFeePaise: 0, taxPaise: 0, pricesIncludeTax: true }).ok, false)
    assert.equal(computeGrandTotal({ subtotalPaise: 1000, discountPaise: 1001, shippingFeePaise: 0, taxPaise: 0, pricesIncludeTax: true }).ok, false)
    const exclusive = computeGrandTotal({ subtotalPaise: 100_000, discountPaise: 10_000, shippingFeePaise: 5_000, taxPaise: 4_500, pricesIncludeTax: false })
    assert.deepEqual(exclusive, { ok: true, value: 99_500 })
    const inclusive = computeGrandTotal({ subtotalPaise: 100_000, discountPaise: 10_000, shippingFeePaise: 5_000, taxPaise: 4_500, pricesIncludeTax: true })
    assert.deepEqual(inclusive, { ok: true, value: 95_000 })
  })
})

describe("no overselling", () => {
  test("the last unit can be reserved once", () => {
    const start = new Map([["SKU-1", { onHand: 1, reserved: 0, allocated: 0 }]])
    const first = reserveAll(start, [{ sku: "SKU-1", quantity: 1 }])
    assert.ok(first.ok)
    assert.equal(availableUnits(first.value.get("SKU-1")), 0)
    const second = reserveAll(first.value, [{ sku: "SKU-1", quantity: 1 }])
    assert.deepEqual(second, { ok: false, code: "out_of_stock", detail: "SKU-1" })
    assert.equal(start.get("SKU-1").reserved, 0, "input balances are not mutated")
  })

  test("a multi-SKU shortage reserves nothing", () => {
    const start = new Map([
      ["SKU-1", { onHand: 5, reserved: 0, allocated: 0 }],
      ["SKU-2", { onHand: 2, reserved: 1, allocated: 1 }],
    ])
    const result = reserveAll(start, [
      { sku: "SKU-1", quantity: 2 },
      { sku: "SKU-2", quantity: 1 },
    ])
    assert.equal(result.ok, false)
    assert.deepEqual(start.get("SKU-1"), { onHand: 5, reserved: 0, allocated: 0 })
  })

  test("negative or inconsistent balances are refused", () => {
    const broken = new Map([["SKU-1", { onHand: 1, reserved: 2, allocated: 0 }]])
    assert.equal(reserveAll(broken, [{ sku: "SKU-1", quantity: 1 }]).ok, false)
  })
})
