// CHV-S10-M04 (Stage 10.04): a published handle loads with the variant to show first; a hidden
// handle does not. Missing and hidden handles are the same 404 to shoppers (so drafts cannot be
// discovered) and are told apart only in the server log; a published product with nothing to buy
// is found and says so. Fixtures only: no real catalogue exists yet.
import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import { setup, staffWithMfa } from "../auth/helpers.mjs"
import { catalogueApi, countStock, fullChecklist, mediaStoreReady, png, readyDraft, sizes, uploadPhoto } from "./helpers.mjs"
import { PUBLIC_SELECTION_FIELDS } from "../../../packages/contracts/src/modules/catalogue.ts"

let ctx, c, admin, owner, ethnic, inStock, soldOut, other
const hidden = {}
const logged = []
const realLog = console.log

async function direct(path, { key = true } = {}) {
  const res = await fetch(ctx.api.url + path, { headers: key ? { "x-chaanavya-internal-key": ctx.api.key } : {} })
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : null, cache: res.headers.get("cache-control") }
}
const product = (handle, query = "") => direct(`/api/v1/catalogue/products/${handle}${query}`)

/** Published by the owner; each variant counted to the given quantity, or left uncounted. */
async function published(title, prefix, counts) {
  const created = (await c.create(admin.jar, readyDraft([ethnic], { title }))).json.data
  const saved = (await c.variants(admin.jar, created.id, created.etag, sizes(prefix))).json.data
  const photo = await uploadPhoto(c, admin.jar, created.id, png(600, 800))
  const approved = (await c.approve(owner.jar, photo.completed.json.data.media.at(-1).id, photo.completed.json.data.etag)).json.data
  const live = (await c.status(owner.jar, created.id, "publish", approved.etag, { reason: "detail fixture", checklist: fullChecklist })).json.data
  if (counts) await countStock(c, admin.jar, owner.jar, saved.variants.map((v, i) => ({ sku: v.sku, counted: counts[i] })))
  return { ...live, variants: saved.variants }
}
const statusTo = async (p, action, reason) => c.status(owner.jar, p.id, action, (await c.get(owner.jar, p.id)).json.data.etag, { reason })

before(async () => {
  await mediaStoreReady()
  ctx = await setup("chaanavya_test_s10_detail")
  c = catalogueApi(ctx)
  admin = await staffWithMfa(ctx, "s10m04.admin@example.com", "ADMIN")
  owner = await staffWithMfa(ctx, "s10m04.owner@example.com", "OWNER")
  ethnic = (await ctx.db.collection.findUnique({ where: { handle: "ethnic-festive" } })).id
  const p = `M04${process.pid}`

  inStock = await published("Detail kurta", `${p}A`, [0, 3]) // S sold out, M in stock
  soldOut = await published("Detail sold out kurta", `${p}B`, [0, 0])
  other = await published("Detail other kurta", `${p}C`, [1, 1])

  const d = (await c.create(admin.jar, readyDraft([ethnic], { title: "Detail draft saree" }))).json.data
  await c.variants(admin.jar, d.id, d.etag, sizes(`${p}D`))
  hidden.draft = d
  hidden.unpublished = await published("Detail unpublished kurta", `${p}U`, [2, 2])
  await statusTo(hidden.unpublished, "unpublish", "pulled from sale")
  hidden.archived = await published("Detail archived kurta", `${p}R`, [2, 2])
  await statusTo(hidden.archived, "archive", "discontinued")
  hidden.uncounted = await published("Detail uncounted kurta", `${p}N`, null)
  hidden.forged = await published("Detail forged kurta", `${p}F`, [2, 2])
  await ctx.db.product.update({ where: { id: hidden.forged.id }, data: { publishedAt: null } })

  console.log = (...args) => {
    const line = args.join(" ")
    if (line.includes("catalogue.product_not_public")) logged.push(JSON.parse(line))
    else realLog(...args)
  }
})
after(() => {
  console.log = realLog
  return ctx?.teardown()
})

test("CHV-S10-M04 a published handle loads with the first variant that can be bought now", async () => {
  const res = await product(inStock.handle)
  assert.equal(res.status, 200)
  assert.equal(res.json.data.id, inStock.id)
  assert.deepEqual(Object.keys(res.json).sort(), ["data", "selection"])
  assert.deepEqual(Object.keys(res.json.selection).sort(), [...PUBLIC_SELECTION_FIELDS].sort())
  const m = res.json.data.variants.find(v => v.sku.endsWith("-M"))
  assert.deepEqual(res.json.selection, { version: 1, selectedVariantId: m.id, selectedBy: "first_available", availableForSale: true })
  assert.match(res.cache, /public, max-age=60/)
  // Through the web host, as the storefront will call it.
  const viaHost = await c.publicGet(inStock.handle)
  assert.deepEqual([viaHost.status, viaHost.json.selection], [200, res.json.selection])
})

test("CHV-S10-M04 the shopper's chosen variant is selected, even when it is sold out", async () => {
  const s = inStock.variants.find(v => v.sku.endsWith("-S"))
  const res = await product(inStock.handle, `?variant=${s.id}`)
  assert.equal(res.status, 200)
  assert.deepEqual(res.json.selection, { version: 1, selectedVariantId: s.id, selectedBy: "requested", availableForSale: true })
  assert.equal(res.json.data.variants.find(v => v.id === s.id).availableForSale, false)
})

test("CHV-S10-M04 a variant from another or hidden product, or an unknown one, falls back and reveals nothing", async () => {
  const fallback = (await product(inStock.handle)).json
  const foreign = [other.variants[0].id, hidden.uncounted.variants[0].id, hidden.archived.variants[0].id, "01900000-0000-7000-8000-000000000000"]
  for (const id of foreign) {
    const res = await product(inStock.handle, `?variant=${id}`)
    assert.equal(res.status, 200)
    assert.deepEqual(res.json, fallback, `variant ${id} is ignored`)
  }
  for (const bad of ["?variant=M", "?variant=1%20OR%201%3D1", "?variant="]) {
    const res = await product(inStock.handle, bad)
    assert.deepEqual([res.status, res.json.error.code], [400, "invalid_request"], bad)
  }
})

test("CHV-S10-M04 a published product with nothing to buy is found and marked unavailable", async () => {
  const res = await product(soldOut.handle)
  assert.equal(res.status, 200)
  assert.deepEqual(res.json.selection, { version: 1, selectedVariantId: res.json.data.variants[0].id, selectedBy: "first", availableForSale: false })
  assert.ok(res.json.data.variants.every(v => v.availableForSale === false))
})

test("CHV-S10-M04 hidden handles do not load and read exactly like a missing one", async t => {
  logged.length = 0
  const level = process.env.LOG_LEVEL
  process.env.LOG_LEVEL = "info"
  t.after(() => (process.env.LOG_LEVEL = level))
  const missing = await product("detail-no-such-product")
  assert.equal(missing.status, 404)
  assert.deepEqual(missing.json, { error: { code: "not_found", message: "not found" } })
  for (const [kind, p] of Object.entries(hidden)) {
    for (const query of ["", `?variant=${inStock.variants[0].id}`]) {
      const res = await product(p.handle, query)
      assert.deepEqual([res.status, res.json], [missing.status, missing.json], `${kind}${query}`)
    }
    const viaHost = await c.publicGet(p.handle)
    assert.equal(viaHost.status, 404, `${kind} through the web host`)
  }
  assert.equal((await product("Not_A_Handle")).status, 404)
  // Only the server log tells the cases apart.
  const reasons = logged.map(l => l.reason ?? l.fields?.reason)
  for (const r of ["missing", "draft", "draft", "archived", "not_counted", "not_published"]) assert.ok(reasons.includes(r), `logged reason ${r}: ${reasons}`)
  assert.ok(logged.every(l => !JSON.stringify(l).includes("Detail")), "the log holds the reason, not titles")
})

test("CHV-S10-M04 without the web host's key the details are refused", async () => {
  const res = await direct(`/api/v1/catalogue/products/${inStock.handle}`, { key: false })
  assert.equal(res.status, 401)
})
