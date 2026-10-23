// CHV-S10-M07 (Stage 10.07), unit part: the API's published product maps to the storefront's Product
// shape without inventing or changing anything (prices stay exact, availability stays the API's).
import { test } from "node:test"
import assert from "node:assert/strict"
import { toStorefrontProduct } from "../../lib/catalogue/map.ts"
import { formatMoney } from "../../lib/types.ts"

const api = {
  version: 1,
  id: "01900000-0000-7000-8000-000000000001",
  handle: "handloom-kurta",
  status: "active",
  title: "Handloom kurta",
  description: "A straight-cut handloom cotton kurta.",
  productType: "Kurta",
  tags: ["cotton"],
  collectionIds: ["01900000-0000-7000-8000-0000000000c1"],
  options: [{ name: "Size", values: ["S", "M"] }],
  media: [
    { id: "01900000-0000-7000-8000-0000000000a1", url: "https://media.example/p/front.jpg", altText: "Front view", width: 800, height: 1000 },
    { id: "01900000-0000-7000-8000-0000000000a2", url: "https://media.example/p/back.jpg", altText: null, width: 800, height: 1000 },
  ],
  variants: [
    { version: 1, id: "01900000-0000-7000-8000-0000000000b1", sku: "K-S", productId: "01900000-0000-7000-8000-000000000001", title: "S", selectedOptions: [{ name: "Size", value: "S" }], price: { amountPaise: 249900, currency: "INR" }, compareAtPrice: null, taxCategory: "apparel", mediaId: "01900000-0000-7000-8000-0000000000a2", legacy: null, availableForSale: false },
    { version: 1, id: "01900000-0000-7000-8000-0000000000b2", sku: "K-M", productId: "01900000-0000-7000-8000-000000000001", title: "M", selectedOptions: [{ name: "Size", value: "M" }], price: { amountPaise: 249950, currency: "INR" }, compareAtPrice: { amountPaise: 299900, currency: "INR" }, taxCategory: "apparel", mediaId: null, legacy: null, availableForSale: true },
  ],
  legacy: null,
}

test("CHV-S10-M07 a published product maps to the storefront shape with exact prices and the API's availability", () => {
  const p = toStorefrontProduct(api)
  assert.deepEqual([p.id, p.handle, p.title, p.description, p.productType, p.tags], [api.id, "handloom-kurta", "Handloom kurta", api.description, "Kurta", ["cotton"]])
  assert.deepEqual(p.options, api.options)
  assert.deepEqual(p.featuredImage, { url: "https://media.example/p/front.jpg", altText: "Front view", width: 800, height: 1000 })
  assert.equal(p.images.length, 2)
  assert.deepEqual(p.variants.map(v => [v.id, v.availableForSale, v.price]), [
    [api.variants[0].id, false, { amount: "2499.00", currencyCode: "INR" }],
    [api.variants[1].id, true, { amount: "2499.50", currencyCode: "INR" }],
  ])
  assert.deepEqual(p.variants.map(v => formatMoney(v.price)), ["₹2,499", "₹2,499.50"])
  assert.equal(p.variants[0].image?.url, "https://media.example/p/back.jpg", "a variant photo is its approved photo")
  assert.equal(p.variants[1].image, null)
  assert.equal(p.collections, undefined, "collection handles are not invented")
})

test("CHV-S10-M07 a product with no photos maps to no image, never a placeholder", () => {
  const p = toStorefrontProduct({ ...api, media: [], variants: api.variants.map(v => ({ ...v, mediaId: null })) })
  assert.deepEqual([p.featuredImage, p.images], [null, []])
})
