// CHV-S10-M09 (Stage 10.09), logic part: choosing a variant shows that variant's own price and
// stock, never another's. Uses the same mapper the product page uses on API data.
import { test } from "node:test"
import assert from "node:assert/strict"
import { toStorefrontProduct } from "../../lib/catalogue/map.ts"
import { formatMoney } from "../../lib/types.ts"
import { isSoldOut, resolveVariant, selectionFor, shownVariant, valueAvailable, fixedSelection } from "../../lib/variants.ts"

const id = n => `01900000-0000-7000-8000-${String(n).padStart(12, "0")}`
const variant = (n, size, paise, compareAt, available) => ({ version: 1, id: id(n), sku: `K-${size}`, productId: id(1), title: size, selectedOptions: [{ name: "Size", value: size }], price: { amountPaise: paise, currency: "INR" }, compareAtPrice: compareAt ? { amountPaise: compareAt, currency: "INR" } : null, taxCategory: "apparel", mediaId: null, legacy: null, availableForSale: available })
const api = (variants, options = [{ name: "Size", values: variants.map(v => v.title) }]) => ({ version: 1, id: id(1), handle: "kurta", status: "active", title: "Kurta", description: "d", productType: "Kurta", tags: [], collectionIds: [], options, media: [], variants, legacy: null })

const product = toStorefrontProduct(api([variant(10, "S", 249900, null, true), variant(11, "M", 269900, 299900, true), variant(12, "L", 289900, null, false)]), ["ethnic-festive"])
const priceOf = v => formatMoney(v.price)

test("CHV-S10-M09 choosing a size resolves to that size's own price, compare-at price and stock", () => {
  const expected = { S: ["₹2,499", null, true], M: ["₹2,699", "₹2,999", true], L: ["₹2,899", null, false] }
  for (const [size, [price, compareAt, available]] of Object.entries(expected)) {
    const v = resolveVariant(product, { Size: size })
    assert.equal(priceOf(v), price, `${size} price`)
    assert.equal(v.compareAtPrice ? formatMoney(v.compareAtPrice) : null, compareAt, `${size} compare-at`)
    assert.equal(v.availableForSale, available, `${size} stock`)
  }
  assert.equal(resolveVariant(product, {}), undefined, "no choice yet means no variant")
  assert.equal(resolveVariant(product, { Size: "XXL" }), undefined, "an unknown size resolves to nothing, not to another variant")
})

test("CHV-S10-M09 before a choice the price shown is the first buyable variant's, and a sold-out choice shows its own price", () => {
  assert.equal(priceOf(shownVariant(product, undefined)), "₹2,499")
  assert.equal(priceOf(shownVariant(product, resolveVariant(product, { Size: "L" }))), "₹2,899", "sold-out L shows L's price")
  assert.equal(isSoldOut(product), false)
  const none = toStorefrontProduct(api([variant(20, "S", 100000, null, false), variant(21, "M", 110000, null, false)]))
  assert.equal(isSoldOut(none), true)
  assert.equal(priceOf(shownVariant(none, undefined)), "₹1,000", "a fully sold-out product still shows its first variant's price")
})

test("CHV-S10-M09 a size is offered only while a variant with it can be bought", () => {
  assert.deepEqual(["S", "M", "L"].map(v => valueAvailable(product, {}, "Size", v)), [true, true, false])
})

test("CHV-S10-M09 a shared variant link preselects that variant's options and ignores other IDs", () => {
  assert.deepEqual(selectionFor(product, id(11)), { Size: "M" })
  assert.deepEqual(selectionFor(product, id(99)), {})
  assert.deepEqual(selectionFor(product, null), {})
  assert.equal(product.collections.join(), "ethnic-festive")
})

test("CHV-S10-M09 a product with one variant and no real choice resolves at once", () => {
  const single = toStorefrontProduct(api([{ ...variant(30, "Default Title", 150000, null, true) }], [{ name: "Title", values: ["Default Title"] }]))
  assert.deepEqual(fixedSelection(single), { Title: "Default Title" })
  assert.equal(priceOf(resolveVariant(single, fixedSelection(single))), "₹1,500")
})
