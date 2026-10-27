// CHV-S12-M06: GST worked out on the server (apps/api/src/tax/compute.ts). Tax totals are
// deterministic and match the worked examples below. The examples were worked out separately with
// plain integer arithmetic under the owner's rules of 27 October 2026 (per line, nearest paisa, half
// up; CGST and SGST each at half the rate; a bag discount shared by line value). The rates and HSN codes
// are synthetic, not tax advice; the tax advisor should confirm the method using these examples.
import { after, before, describe, test } from "node:test"
import assert from "node:assert/strict"
import { apiModule, setup } from "../auth/helpers.mjs"

let ctx, tax, profile, ApiError

const RATES = [
  { taxCategory: "apparel_5", hsnCode: "6204", rateBasisPoints: 500 },
  { taxCategory: "apparel_12", hsnCode: "6206", rateBasisPoints: 1200 },
  { taxCategory: "tiny_rate", hsnCode: "7113", rateBasisPoints: 25 },
  { taxCategory: "metal_3", hsnCode: "711319", rateBasisPoints: 300 },
]
const prof = (overrides = {}) => ({ id: "00000000-0000-7000-8000-000000000001", approved: true, sellerStateCode: "IN-KA", pricesIncludeTax: true, rates: RATES, ...overrides })
const line = (key, taxCategory, unitPricePaise, quantity = 1) => ({ key, taxCategory, unitPricePaise: BigInt(unitPricePaise), quantity })
const run = (lines, { discount = 0, delivery = "IN-KA", ...p } = {}) => tax.computeTax({ lines, discountPaise: BigInt(discount), profile: prof(p), deliveryStateCode: delivery })
/** A line's result as plain numbers: [discount, taxable, [component, amount]..., total]. */
const brief = l => [Number(l.discountPaise), Number(l.taxablePaise), ...l.tax.map(t => [t.component, Number(t.amountPaise)]), Number(l.totalPaise)]

before(async () => {
  ctx = await setup("chaanavya_test_s12_tax_compute")
  tax = await apiModule("tax/compute")
  profile = await apiModule("tax/profile")
  ;({ ApiError } = await apiModule("admin/api"))
})
after(() => ctx?.teardown())

describe("CHV-S12-M06 worked examples (GST-inclusive prices)", () => {
  test("E1 one line at 5% within Karnataka: CGST 45.21 + SGST 45.21 taken out of 1,899.00", () => {
    const r = run([line("kurta", "apparel_5", 189900)])
    assert.equal(r.supply, "intra")
    assert.deepEqual(brief(r.lines[0]), [0, 180858, ["CGST", 4521], ["SGST", 4521], 189900])
    assert.equal(r.taxPaise, 9042n)
    assert.equal(r.totalPaise, 189900n, "the shopper pays exactly the price")
  })

  test("E2 the same line delivered to Maharashtra: IGST 90.43 (one rounding instead of two)", () => {
    const r = run([line("kurta", "apparel_5", 189900)], { delivery: "IN-MH" })
    assert.equal(r.supply, "inter")
    assert.deepEqual(brief(r.lines[0]), [0, 180857, ["IGST", 9043], 189900])
  })

  test("E3 two lines, 5% and 12%, with a 100.00 bag discount shared 48.73 / 51.27", () => {
    const r = run([line("kurta", "apparel_5", 189900), line("scarf", "apparel_12", 99900, 2)], { discount: 10000 })
    assert.deepEqual(r.lines.map(brief), [
      [4873, 176217, ["CGST", 4405], ["SGST", 4405], 185027],
      [5127, 173815, ["CGST", 10429], ["SGST", 10429], 194673],
    ])
    assert.equal(r.subtotalPaise, 389700n)
    assert.equal(r.discountPaise, 10000n)
    assert.equal(r.taxPaise, 8810n + 20858n)
    assert.equal(r.totalPaise, 379700n, "subtotal minus discount, tax included")
  })

  test("E5 a fractional half rate (0.25%) and 3% on three units", () => {
    const r = run([line("pin", "tiny_rate", 100), line("ring", "metal_3", 999, 3)])
    assert.deepEqual(r.lines.map(brief), [
      [0, 100, ["CGST", 0], ["SGST", 0], 100],
      [0, 2909, ["CGST", 44], ["SGST", 44], 2997],
    ])
    assert.equal(r.lines[0].tax[0].rateBasisPoints, 12.5)
  })

  test("E6 a 0.02 discount over three equal lines goes to the first two (ties to the earlier line)", () => {
    const r = run([line("a", "apparel_5", 100), line("b", "apparel_5", 100), line("c", "apparel_5", 100)], { discount: 2 })
    assert.deepEqual(r.lines.map(brief), [
      [1, 95, ["CGST", 2], ["SGST", 2], 99],
      [1, 95, ["CGST", 2], ["SGST", 2], 99],
      [0, 96, ["CGST", 2], ["SGST", 2], 100],
    ])
  })

  test("a seller in a union territory without a legislature charges UTGST, not SGST", () => {
    const r = run([line("kurta", "apparel_5", 189900)], { sellerStateCode: "IN-CH", delivery: "IN-CH" })
    assert.deepEqual(r.lines[0].tax.map(t => t.component), ["CGST", "UTGST"])
    assert.deepEqual(run([line("kurta", "apparel_5", 189900)], { sellerStateCode: "IN-DL", delivery: "IN-DL" }).lines[0].tax.map(t => t.component), ["CGST", "SGST"], "Delhi has a legislature")
  })
})

describe("CHV-S12-M06 worked example (prices before tax)", () => {
  test("E4 tax added on top, delivered out of state: IGST 92.51 and 233.61", () => {
    const r = run([line("kurta", "apparel_5", 189900), line("scarf", "apparel_12", 99900, 2)], { discount: 10000, delivery: "IN-MH", pricesIncludeTax: false })
    assert.deepEqual(r.lines.map(brief), [
      [4873, 185027, ["IGST", 9251], 194278],
      [5127, 194673, ["IGST", 23361], 218034],
    ])
    assert.equal(r.totalPaise, 412312n)
  })
})

describe("CHV-S12-M06 determinism and integers", () => {
  test("the same input always gives the same result, and line order is kept", () => {
    const lines = [line("kurta", "apparel_5", 189900), line("scarf", "apparel_12", 99900, 2)]
    const a = JSON.stringify(run(lines, { discount: 10000 }), (_k, v) => (typeof v === "bigint" ? `${v}n` : v))
    for (let i = 0; i < 50; i++) assert.equal(JSON.stringify(run(lines, { discount: 10000 }), (_k, v) => (typeof v === "bigint" ? `${v}n` : v)), a)
  })

  test("every amount is a bigint; totals are the sums of the lines; discounts sum to the bag discount", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const n = 1 + (seed % 5)
      const lines = Array.from({ length: n }, (_, i) => line(`l${i}`, RATES[(seed + i) % RATES.length].taxCategory, ((seed * 7919 + i * 104729) % 500000) + 1, 1 + ((seed + i) % 10)))
      const subtotal = lines.reduce((a, l) => a + l.unitPricePaise * BigInt(l.quantity), 0n)
      const discount = (subtotal * BigInt(seed % 37)) / 100n
      for (const inclusive of [true, false]) {
        const r = run(lines, { discount: Number(discount), delivery: seed % 2 ? "IN-KA" : "IN-TN", pricesIncludeTax: inclusive })
        assert.equal(r.lines.reduce((a, l) => a + l.discountPaise, 0n), discount)
        assert.equal(r.taxPaise, r.lines.reduce((a, l) => a + l.taxPaise, 0n))
        assert.equal(r.totalPaise, r.lines.reduce((a, l) => a + l.totalPaise, 0n))
        for (const l of r.lines) {
          for (const v of [l.grossPaise, l.discountPaise, l.taxablePaise, l.taxPaise, l.totalPaise, ...l.tax.map(t => t.amountPaise)]) {
            assert.equal(typeof v, "bigint")
            assert.ok(v >= 0n)
          }
          if (inclusive) assert.equal(l.totalPaise, l.grossPaise - l.discountPaise, "inclusive: the shopper pays the discounted price exactly")
          else assert.equal(l.taxablePaise, l.grossPaise - l.discountPaise)
          if (r.supply === "intra") assert.equal(l.tax[0].amountPaise, l.tax[1].amountPaise, "CGST equals SGST")
        }
      }
    }
  })

  test("half up: exactly half a paisa rounds up, just under half rounds down", () => {
    assert.equal(tax.roundHalfUp(5n, 10n), 1n)
    assert.equal(tax.roundHalfUp(4n, 10n), 0n)
    assert.equal(tax.roundHalfUp(15n, 10n), 2n)
    assert.equal(tax.roundHalfUp(0n, 7n), 0n)
    assert.deepEqual(tax.allocate(7n, [10n, 10n, 10n]), [3n, 2n, 2n])
    assert.throws(() => tax.allocate(10n, [1n, 1n, 1n]), RangeError, "never more than the total")
    assert.deepEqual(tax.allocate(0n, [5n, 5n]), [0n, 0n])
  })
})

describe("CHV-S12-M06 refusals and the quote snapshot", () => {
  test("a category without a rate, a bad delivery state, a discount over the bag or a bad quantity is refused, never taxed at zero", () => {
    const refused = (fn, field) => assert.throws(fn, error => error instanceof ApiError && Object.hasOwn(error.fields ?? {}, field), field)
    refused(() => run([line("x", "no_such_category", 100)]), "tax.no_such_category")
    refused(() => run([line("x", "apparel_5", 100)], { delivery: "IN-ZZ" }), "deliveryStateCode")
    refused(() => run([line("x", "apparel_5", 100)], { discount: 101 }), "discount")
    refused(() => run([line("x", "apparel_5", 100, 0)]), "lines.0.quantity")
    refused(() => run([line("x", "apparel_5", 100, 1.5)]), "lines.0.quantity")
    refused(() => run([line("x", "apparel_5", 100)], { sellerStateCode: "KA" }), "sellerStateCode")
  })

  test("each line carries the classification a quote freezes: profile, category, HSN, rate, supply, states, rounding", () => {
    const r = run([line("kurta", "apparel_5", 189900)], { delivery: "in-mh" })
    assert.deepEqual(r.lines[0].classification, {
      taxProfileId: "00000000-0000-7000-8000-000000000001",
      profileApproved: true,
      taxCategory: "apparel_5",
      hsnCode: "6204",
      rateBasisPoints: 500,
      supply: "inter",
      sellerStateCode: "IN-KA",
      deliveryStateCode: "IN-MH",
      pricesIncludeTax: true,
      rounding: "line_half_up_v1",
    })
  })

  test("with the database: production refuses without an approved active profile; elsewhere a draft is used and marked unapproved", async () => {
    const owner = await ctx.db.user.create({ data: { email: "synthetic.tax.owner@example.com" } })
    const input = { lines: [line("kurta", "apparel_5", 189900)], discountPaise: 0n, deliveryStateCode: "IN-KA" }
    await assert.rejects(profile.taxForBag(ctx.db, "production", input), error => error.fields?.tax === "no_active_profile")
    await ctx.db.taxProfile.create({ data: { sellerStateCode: "IN-KA", createdById: owner.id, rates: { create: [{ taxCategory: "apparel_5", hsnCode: "6204", rateBasisPoints: 500 }] } } })
    await assert.rejects(profile.taxForBag(ctx.db, "production", input), "a draft is never used in production")
    const test = await profile.taxForBag(ctx.db, "development", input)
    assert.equal(test.lines[0].classification.profileApproved, false)
    assert.equal(test.taxPaise, 9042n, "the same arithmetic as E1")
  })
})
