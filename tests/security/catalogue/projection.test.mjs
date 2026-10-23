// CHV-S10-M02 (Stage 10.02): the public product and variant DTOs hold exactly the fields the
// contract lists. Private columns (stock levels, HSN, weight, shipping class, approval, storage
// keys, versions) and anything about drafts, archived variants or unapproved photos never appear.
// Fixtures only: no real catalogue exists yet.
import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import { setup, staffWithMfa } from "../auth/helpers.mjs"
import { catalogueApi, countStock, fullChecklist, mediaStoreReady, png, readyDraft, uploadPhoto } from "./helpers.mjs"
import { PUBLIC_COLLECTION_FIELDS, PUBLIC_MEDIA_FIELDS, PUBLIC_PRODUCT_FIELDS, PUBLIC_VARIANT_FIELDS } from "../../../packages/contracts/src/modules/catalogue.ts"
import { CatalogueSchemas } from "../../../apps/api/src/http/schemas.ts"

const HSN = "62114290"
let ctx, c, admin, owner, live, draft, archivedSku, pendingPhotoId

const sorted = keys => [...keys].sort()
const tag = `M02${process.pid}`

before(async () => {
  await mediaStoreReady()
  ctx = await setup("chaanavya_test_s10_projection")
  c = catalogueApi(ctx)
  admin = await staffWithMfa(ctx, "s10m02.admin@example.com", "ADMIN")
  owner = await staffWithMfa(ctx, "s10m02.owner@example.com", "OWNER")
  const ethnic = (await ctx.db.collection.findUnique({ where: { handle: "ethnic-festive" } })).id

  const created = (await c.create(admin.jar, readyDraft([ethnic], { title: "Projection kurta" }))).json.data
  const variant = size => ({ options: { Size: size }, sku: `${tag}-${size}`, pricePaise: "249900", compareAtPricePaise: "299900", taxCategory: "apparel", hsnCode: HSN, weightGrams: 431 })
  const three = (await c.variants(admin.jar, created.id, created.etag, { options: [{ name: "Size", values: ["S", "M", "L"] }], variants: ["S", "M", "L"].map(variant) })).json.data
  // Archive L before publishing: an archived variant must never reach shoppers.
  const kept = three.variants.filter(v => v.sku !== `${tag}-L`)
  archivedSku = `${tag}-L`
  const two = (await c.variants(admin.jar, created.id, three.etag, { options: [{ name: "Size", values: ["S", "M"] }], variants: kept.map(v => ({ ...variant(v.sku.slice(-1)), id: v.id })) })).json.data
  const photo = await uploadPhoto(c, admin.jar, created.id, png(600, 800))
  const approved = (await c.approve(owner.jar, photo.completed.json.data.media.at(-1).id, photo.completed.json.data.etag)).json.data
  live = (await c.status(owner.jar, created.id, "publish", approved.etag, { reason: "projection fixture", checklist: fullChecklist })).json.data
  await countStock(c, admin.jar, owner.jar, two.variants.map((v, i) => ({ sku: v.sku, counted: i === 0 ? 7 : 0 })))
  // A second photo left waiting for review on the live product.
  const pending = await uploadPhoto(c, admin.jar, created.id, png(640, 800, [20, 120, 80]), { altText: "Pending back view" })
  pendingPhotoId = pending.completed.json.data.media.at(-1).id
  draft = (await c.create(admin.jar, readyDraft([ethnic], { title: "Projection draft saree" }))).json.data
})
after(() => ctx?.teardown())

function assertShape(product) {
  assert.deepEqual(sorted(Object.keys(product)), sorted(PUBLIC_PRODUCT_FIELDS), "product fields are exactly the public list")
  for (const v of product.variants) assert.deepEqual(sorted(Object.keys(v)), sorted(PUBLIC_VARIANT_FIELDS), `variant ${v.sku} fields`)
  for (const m of product.media) assert.deepEqual(sorted(Object.keys(m)), sorted(PUBLIC_MEDIA_FIELDS), "media fields")
  for (const v of product.variants) assert.deepEqual(sorted(Object.keys(v.price)), ["amountPaise", "currency"])
}

test("CHV-S10-M02 the public product, variant and photo DTOs hold exactly the contract's fields", async () => {
  const one = (await c.publicGet(live.handle)).json.data
  assertShape(one)
  const listed = (await c.publicList()).json.data
  assert.equal(listed.length, 1)
  assertShape(listed[0])
  assert.deepEqual(listed[0], one, "list and detail project the same DTO")
  for (const col of (await c.publicCollections()).json.data) assert.deepEqual(sorted(Object.keys(col)), sorted(PUBLIC_COLLECTION_FIELDS))
})

test("CHV-S10-M02 private columns never leave the API, even though the rows hold them", async () => {
  const body = JSON.stringify((await c.publicGet(live.handle)).json)
  const row = await ctx.db.product.findUnique({ where: { id: live.id }, include: { variants: { include: { balance: true } }, media: true } })
  // The fixture really has the private values, so their absence below means something.
  assert.ok(row.variants.every(v => v.hsnCode === HSN && v.weightGrams === 431))
  assert.ok(row.approvedById && row.shippingRestriction && row.media.some(m => m.storageKey && m.checksumSha256))

  for (const key of ["hsnCode", "weightGrams", "shippingRestriction", "approval", "approvedAt", "approvedById", "publishedAt", "createdAt", "updatedAt", "optionKey", "position", "archivedAt", "onHand", "reserved", "allocated", "lastCountedAt", "lowStockThreshold", "storageKey", "stagingKey", "checksumSha256", "byteSize", "contentType", "legacyShopifyUrl", "costPaise", "supplier", "etag"]) {
    assert.ok(!body.includes(`"${key}"`), `${key} is not in the public response`)
  }
  assert.ok(!body.includes(HSN), "HSN value absent")
  assert.ok(!body.includes(row.approvedById), "approver ID absent")
  for (const m of row.media) {
    if (m.storageKey) assert.ok(!body.includes(m.checksumSha256), "photo checksum absent")
  }
  const shown = JSON.parse(body).data
  assert.ok(!shown.variants.some(v => "version" in v && v.version !== 1), "variant version is the contract version, not the row's ETag version")
  assert.deepEqual(shown.variants.map(v => v.availableForSale), [true, false], "availability is a boolean, never the counted 7")
  assert.ok(!/"[a-zA-Z]+":7[,}]/.test(body), "the stock count 7 appears nowhere")
})

test("CHV-S10-M02 drafts, archived variants and unapproved photos are not in the projection", async () => {
  const shown = (await c.publicGet(live.handle)).json.data
  assert.equal(shown.status, "active")
  assert.deepEqual(shown.variants.map(v => v.sku), [`${tag}-S`, `${tag}-M`])
  assert.ok(!JSON.stringify(shown).includes(archivedSku), "archived SKU absent")
  assert.ok(!shown.media.some(m => m.id === pendingPhotoId), "pending photo absent")
  assert.equal(shown.media.length, 1)
  assert.equal((await c.publicGet(draft.handle)).status, 404)
  const all = JSON.stringify((await c.publicList()).json)
  assert.ok(!all.includes(draft.id) && !all.includes("Projection draft saree"), "draft absent from the list")
})

test("CHV-S10-M02 the published OpenAPI schema is closed and matches the contract's field lists", () => {
  const product = CatalogueSchemas.publicProduct
  const variant = product.properties.variants.items
  const media = product.properties.media.items
  for (const [schema, fields] of [[product, PUBLIC_PRODUCT_FIELDS], [variant, PUBLIC_VARIANT_FIELDS], [media, PUBLIC_MEDIA_FIELDS], [CatalogueSchemas.publicCollection, PUBLIC_COLLECTION_FIELDS]]) {
    assert.equal(schema.additionalProperties, false)
    assert.deepEqual(sorted(Object.keys(schema.properties)), sorted(fields))
    assert.deepEqual(sorted(schema.required), sorted(fields))
  }
  assert.deepEqual(product.properties.status.enum, ["active"])
})
