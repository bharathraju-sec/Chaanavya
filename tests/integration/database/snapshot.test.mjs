// CHV-S04-003: order item snapshots stay unchanged after later product edits.
import { after, before, describe, test } from "node:test"
import assert from "node:assert/strict"
import { dropDatabase, freshDatabase, makeVariant, orderData } from "./helpers.mjs"

const NAME = "chaanavya_test_snapshot"
let db

before(() => ({ client: db } = freshDatabase(NAME)))
after(async () => {
  await db?.$disconnect()
  dropDatabase(NAME)
})

const snapshotFields = item => ({
  sku: item.sku,
  productTitle: item.productTitle,
  variantTitle: item.variantTitle,
  handle: item.handle,
  imageUrl: item.imageUrl,
  hsnCode: item.hsnCode,
  quantity: item.quantity,
  unitPricePaise: item.unitPricePaise,
  taxLines: item.taxLines,
  lineTotalPaise: item.lineTotalPaise,
})

describe("CHV-S04-003 order item snapshots", () => {
  test("renaming, repricing, re-SKUing and archiving the product leaves the order item untouched", async () => {
    const { product, variant } = await makeVariant(db, { pricePaise: BigInt(199900), title: "M" })
    const order = await db.order.create({
      data: orderData({
        items: {
          create: [
            {
              variantId: variant.id,
              sku: variant.sku,
              productTitle: product.title,
              variantTitle: variant.title,
              handle: product.handle,
              imageUrl: "https://example.com/synthetic.jpg",
              hsnCode: "0000",
              quantity: 1,
              unitPricePaise: variant.pricePaise,
              taxLines: [{ component: "IGST", rateBasisPoints: 500, amount: { amountPaise: 9519, currency: "INR" } }],
              lineTotalPaise: variant.pricePaise,
            },
          ],
        },
      }),
      include: { items: true },
    })
    const before = snapshotFields(order.items[0])

    await db.product.update({ where: { id: product.id }, data: { title: "Renamed synthetic product", handle: `${product.handle}-renamed` } })
    await db.productVariant.update({ where: { id: variant.id }, data: { pricePaise: BigInt(249900), title: "Medium", sku: `${variant.sku}-NEW`, hsnCode: "9999" } })
    await db.productVariant.update({ where: { id: variant.id }, data: { archivedAt: new Date() } })
    await db.product.update({ where: { id: product.id }, data: { status: "archived" } })

    const after = await db.orderItem.findFirstOrThrow({ where: { orderId: order.id } })
    assert.deepEqual(snapshotFields(after), before)
    assert.equal(after.variantId, variant.id, "the link to the variant is kept while the variant exists")
  })

  test("deleting the variant keeps the snapshot and clears only the link", async () => {
    const { product, variant } = await makeVariant(db)
    const order = await db.order.create({
      data: orderData({ items: { create: [{ variantId: variant.id, sku: variant.sku, productTitle: product.title, variantTitle: variant.title, handle: product.handle, quantity: 1, unitPricePaise: variant.pricePaise, lineTotalPaise: variant.pricePaise }] } }),
      include: { items: true },
    })
    await db.inventoryBalance.delete({ where: { variantId: variant.id } })
    await db.productVariant.delete({ where: { id: variant.id } })
    const after = await db.orderItem.findFirstOrThrow({ where: { orderId: order.id } })
    assert.equal(after.variantId, null)
    assert.deepEqual(snapshotFields(after), snapshotFields(order.items[0]))
  })

  test("the frozen shipping address is independent of the address book", async () => {
    const user = await db.user.create({ data: { email: "synthetic.snapshot@example.com" } })
    const address = await db.address.create({ data: { userId: user.id, name: "Synthetic", phone: "+916000000000", line1: "Old Road", city: "Mysuru", district: "Mysuru", stateCode: "IN-KA", pinCode: "570001" } })
    const { name, phone, line1, line2, landmark, city, district, stateCode, pinCode, country } = address
    const order = await db.order.create({ data: orderData({ userId: user.id, shippingAddress: { name, phone, line1, line2, landmark, city, district, stateCode, pinCode, country } }) })
    await db.address.update({ where: { id: address.id }, data: { line1: "New Road" } })
    const after = await db.order.findUniqueOrThrow({ where: { id: order.id } })
    assert.equal(after.shippingAddress.line1, "Old Road")
  })
})
