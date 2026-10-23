// CHV-S10-M01 (Stage 10.01): a SKU, a variant and an unpublished item can each be traced from what
// readers see to the source of truth (the database behind the NestJS API). Fixtures only: no real
// catalogue exists yet.
import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import { setup, staffWithMfa } from "../auth/helpers.mjs"
import { catalogueApi, countStock, fullChecklist, mediaStoreReady, png, readyDraft, sizes, uploadPhoto } from "./helpers.mjs"

let ctx, c, admin, owner, live, draft

before(async () => {
  await mediaStoreReady()
  ctx = await setup("chaanavya_test_s10_trace")
  c = catalogueApi(ctx)
  admin = await staffWithMfa(ctx, "s10.admin@example.com", "ADMIN")
  owner = await staffWithMfa(ctx, "s10.owner@example.com", "OWNER")
  const ethnic = (await ctx.db.collection.findUnique({ where: { handle: "ethnic-festive" } })).id

  const created = (await c.create(admin.jar, readyDraft([ethnic], { title: "Trace kurta" }))).json.data
  const saved = (await c.variants(admin.jar, created.id, created.etag, sizes(`TRACE${process.pid}`))).json.data
  const photo = await uploadPhoto(c, admin.jar, created.id, png(600, 800))
  const approved = (await c.approve(owner.jar, photo.completed.json.data.media.at(-1).id, photo.completed.json.data.etag)).json.data
  live = (await c.status(owner.jar, created.id, "publish", approved.etag, { reason: "trace fixture", checklist: fullChecklist })).json.data
  await countStock(c, admin.jar, owner.jar, saved.variants.map((v, i) => ({ sku: v.sku, counted: i === 0 ? 3 : 0 })))
  draft = (await c.create(admin.jar, readyDraft([ethnic], { title: "Trace draft saree" }))).json.data
})
after(() => ctx?.teardown())

test("CHV-S10-M01 a public SKU and variant are the database's rows, with price and availability from their source columns", async () => {
  const shown = (await c.publicGet(live.handle)).json.data
  assert.equal(shown.id, live.id)
  for (const v of shown.variants) {
    const row = await ctx.db.productVariant.findUnique({ where: { id: v.id }, include: { balance: true } })
    assert.ok(row, `variant ${v.id} exists in product_variant`)
    assert.equal(row.productId, shown.id)
    assert.equal(v.sku, row.sku)
    assert.deepEqual(v.price, { amountPaise: Number(row.pricePaise), currency: row.currency })
    assert.equal(v.availableForSale, row.balance.onHand - row.balance.reserved - row.balance.allocated > 0)
    assert.ok(row.balance.lastCountedAt, "every public variant was counted in a signed stocktake")
  }
  assert.deepEqual(shown.variants.map(v => v.availableForSale), [true, false])
  const ledger = await ctx.db.inventoryMovement.findMany({ where: { variantId: shown.variants[0].id } })
  assert.deepEqual(ledger.map(m => [m.type, m.quantity, m.referenceType]), [["correction", 3, "stocktake"]], "the stock behind availableForSale comes from the signed count")
  const media = await ctx.db.productMedia.findUnique({ where: { id: shown.media[0].id } })
  assert.equal(media.status, "approved")
  assert.equal(shown.media[0].url, media.url)
})

test("CHV-S10-M01 an unpublished item is absent from public reads but traceable to its row by staff", async () => {
  assert.equal((await c.publicGet(draft.handle)).status, 404)
  assert.ok(!(await c.publicList()).json.data.some(p => p.id === draft.id))
  const found = (await c.list(admin.jar, `?status=draft&search=${encodeURIComponent("Trace draft")}`)).json.data
  assert.deepEqual(found.map(p => p.id), [draft.id])
  const row = await ctx.db.product.findUnique({ where: { id: draft.id } })
  assert.deepEqual([row.status, row.handle, row.publishedAt], ["draft", draft.handle, null])
})

test("CHV-S10-M01 the storefront still reads only the placeholder module, so no demo product reaches the API", async () => {
  const { readFileSync } = await import("node:fs")
  const storefront = readFileSync(new URL("../../../lib/catalogue/storefront.ts", import.meta.url), "utf8")
  assert.match(storefront, /from "@\/lib\/catalog"/, "unchanged until Stages 10.06 to 10.09")
  const titles = (await c.publicList()).json.data.map(p => p.title)
  assert.deepEqual(titles, ["Trace kurta"], "public reads hold only the published, counted fixture")
})
