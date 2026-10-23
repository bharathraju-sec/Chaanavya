// CHV-S04-002: money stays precise without floating-point arithmetic.
import { after, before, describe, test } from "node:test"
import assert from "node:assert/strict"
import { fromPaise, MoneyPrecisionError, sumPaise, toPaise } from "../../../apps/api/src/db/money.ts"
import { describeError, dropDatabase, freshDatabase, makeVariant, orderData, psql } from "./helpers.mjs"

const NAME = "chaanavya_test_money"
let db

before(() => ({ client: db } = freshDatabase(NAME)))
after(async () => {
  await db?.$disconnect()
  dropDatabase(NAME)
})

describe("CHV-S04-002 conversions", () => {
  test("bigint and number paise convert exactly within the safe range", () => {
    assert.equal(toPaise(BigInt(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER)
    assert.equal(fromPaise(349900), BigInt(349900))
    assert.throws(() => toPaise(BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1)), MoneyPrecisionError)
    assert.throws(() => toPaise(BigInt(-1)), MoneyPrecisionError)
    for (const bad of [19.99, -1, Number.NaN, Number.MAX_SAFE_INTEGER + 1, Infinity]) assert.throws(() => fromPaise(bad), MoneyPrecisionError, String(bad))
  })
})

describe("CHV-S04-002 storage", () => {
  test("extreme amounts round-trip through bigint columns unchanged", async () => {
    for (const amount of [BigInt(0), BigInt(1), BigInt(99), BigInt(Number.MAX_SAFE_INTEGER), BigInt("9223372036854775807")]) {
      const { variant } = await makeVariant(db, { pricePaise: amount })
      const read = await db.productVariant.findUniqueOrThrow({ where: { id: variant.id } })
      assert.equal(read.pricePaise, amount)
      assert.equal(typeof read.pricePaise, "bigint")
    }
  })

  test("sums are exact where floats drift", async () => {
    const product = await db.product.create({ data: { handle: "synthetic-money-sum", title: "Synthetic" } })
    const prices = Array.from({ length: 300 }, (_, i) => ({ productId: product.id, sku: `SYN-SUM-${i}`, title: "x", optionKey: `k${i}`, pricePaise: BigInt(10) }))
    await db.productVariant.createMany({ data: prices })
    const dbSum = await db.productVariant.aggregate({ where: { productId: product.id }, _sum: { pricePaise: true } })
    assert.equal(dbSum._sum.pricePaise, BigInt(3000))
    assert.equal(sumPaise(prices.map(p => p.pricePaise)), BigInt(3000))
    // The same total in rupee floats is wrong: 300 x 0.10 does not equal 30.
    assert.notEqual(prices.reduce(total => total + 0.1, 0), 30)
  })

  test("fractional or negative amounts are refused by the database", async () => {
    const { variant } = await makeVariant(db)
    assert.notEqual(psql(NAME, `UPDATE product_variant SET price_paise = '19.99' WHERE id = '${variant.id}'`).status, 0)
    await assert.rejects(db.productVariant.update({ where: { id: variant.id }, data: { pricePaise: BigInt(-1) } }), error => /product_variant_price_non_negative|23514/.test(describeError(error)))
  })

  test("order totals must add up in paise", async () => {
    // Prices include tax: grand = subtotal - discount + shipping.
    assert.ok(await db.order.create({ data: orderData({ subtotalPaise: BigInt(349900), discountTotalPaise: BigInt(34990), shippingFeePaise: BigInt(9900), taxTotalPaise: BigInt(16662), grandTotalPaise: BigInt(324810) }) }))
    // Prices exclude tax: grand also adds tax.
    assert.ok(await db.order.create({ data: orderData({ pricesIncludeTax: false, subtotalPaise: BigInt(100000), taxTotalPaise: BigInt(18000), grandTotalPaise: BigInt(118000) }) }))
    await assert.rejects(db.order.create({ data: orderData({ subtotalPaise: BigInt(100000), grandTotalPaise: BigInt(99999) }) }), error => /order_grand_total_consistent|23514/.test(describeError(error)))
    await assert.rejects(db.order.create({ data: orderData({ subtotalPaise: BigInt(100), discountTotalPaise: BigInt(101), grandTotalPaise: BigInt(0) }) }), error => /order_discount_within_subtotal|order_amounts|23514/.test(describeError(error)))
  })

  test("order numbers come from the database sequence", async () => {
    const a = await db.order.create({ data: orderData() })
    const b = await db.order.create({ data: orderData() })
    assert.match(a.number, /^CHV-\d{6,}$/)
    assert.equal(Number(b.number.slice(4)), Number(a.number.slice(4)) + 1)
  })
})
