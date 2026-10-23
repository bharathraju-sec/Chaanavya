// CHV-S10-M05 (Stage 10.05): a collection page by handle returns only its published members, newest
// published first with ties broken by ID, in bounded pages. Hidden and unknown collections are the
// same 404. Called directly on the NestJS API. Fixtures only: no real catalogue exists yet.
import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import { setup, staffWithMfa } from "../auth/helpers.mjs"
import { catalogueApi, countStock, fullChecklist, mediaStoreReady, png, readyDraft, sizes, uploadPhoto } from "./helpers.mjs"
import { PUBLIC_COLLECTION_FIELDS, PUBLIC_COLLECTION_PAGE_FIELDS, PUBLIC_PRODUCT_FIELDS } from "../../../packages/contracts/src/modules/catalogue.ts"

let ctx, c, admin, owner, ethnic, dresses, hidden
const members = []
const excluded = {}

async function direct(path, { key = true } = {}) {
  const res = await fetch(ctx.api.url + path, { headers: key ? { "x-chaanavya-internal-key": ctx.api.key } : {} })
  const text = await res.text()
  return { status: res.status, text, json: text ? JSON.parse(text) : null }
}
const page = (handle, query = "") => direct(`/api/v1/catalogue/collections/${handle}${query}`)
const cursorOf = value => Buffer.from(JSON.stringify(value)).toString("base64url")

async function published(title, prefix, collectionIds, { count = true } = {}) {
  const created = (await c.create(admin.jar, readyDraft(collectionIds, { title }))).json.data
  const saved = (await c.variants(admin.jar, created.id, created.etag, sizes(prefix))).json.data
  const photo = await uploadPhoto(c, admin.jar, created.id, png(600, 800))
  const approved = (await c.approve(owner.jar, photo.completed.json.data.media.at(-1).id, photo.completed.json.data.etag)).json.data
  const live = (await c.status(owner.jar, created.id, "publish", approved.etag, { reason: "collection fixture", checklist: fullChecklist })).json.data
  if (count) await countStock(c, admin.jar, owner.jar, saved.variants.map(v => ({ sku: v.sku, counted: 1 })))
  return live
}
const statusTo = async (p, action, reason) => c.status(owner.jar, p.id, action, (await c.get(owner.jar, p.id)).json.data.etag, { reason })

before(async () => {
  await mediaStoreReady()
  ctx = await setup("chaanavya_test_s10_collection")
  c = catalogueApi(ctx)
  admin = await staffWithMfa(ctx, "s10m05.admin@example.com", "ADMIN")
  owner = await staffWithMfa(ctx, "s10m05.owner@example.com", "OWNER")
  ethnic = await ctx.db.collection.findUnique({ where: { handle: "ethnic-festive" } })
  dresses = await ctx.db.collection.findUnique({ where: { handle: "dresses" } })
  hidden = (await c.createCollection(admin.jar, { handle: "m05-hidden", title: "M05 hidden" })).json.data
  const p = `M05${process.pid}`

  for (const [i, letter] of ["A", "B", "C", "D"].entries()) members.push(await published(`Collection kurta ${letter}`, `${p}${letter}`, i === 3 ? [ethnic.id, dresses.id, hidden.id] : [ethnic.id]))
  // B and C share a published time: the ID decides, highest first.
  // Fixed offsets in the future, so they stay newer than anything published "now" while the test runs.
  const day = 86_400_000
  const future = Date.now() + 10 * day
  const shared = new Date(future + 2 * day)
  await ctx.db.product.updateMany({ where: { id: { in: [members[1].id, members[2].id] } }, data: { publishedAt: shared } })
  await ctx.db.product.update({ where: { id: members[0].id }, data: { publishedAt: new Date(future + day) } })
  await ctx.db.product.update({ where: { id: members[3].id }, data: { publishedAt: new Date(future + 3 * day) } })

  const d = (await c.create(admin.jar, readyDraft([ethnic.id], { title: "Collection draft saree" }))).json.data
  await c.variants(admin.jar, d.id, d.etag, sizes(`${p}X`))
  excluded.draft = d
  excluded.unpublished = await published("Collection unpublished kurta", `${p}U`, [ethnic.id])
  await statusTo(excluded.unpublished, "unpublish", "pulled from sale")
  excluded.archived = await published("Collection archived kurta", `${p}R`, [ethnic.id])
  await statusTo(excluded.archived, "archive", "discontinued")
  excluded.uncounted = await published("Collection uncounted kurta", `${p}N`, [ethnic.id], { count: false })
  excluded.forged = await published("Collection forged kurta", `${p}F`, [ethnic.id])
  await ctx.db.product.update({ where: { id: excluded.forged.id }, data: { publishedAt: null } })
  excluded.otherCollection = await published("Collection dress elsewhere", `${p}O`, [dresses.id])
})
after(() => ctx?.teardown())

/** Newest published first, ties by ID descending: computed from the rows, not assumed. */
async function expectedOrder() {
  const rows = await ctx.db.product.findMany({ where: { id: { in: members.map(m => m.id) } }, select: { id: true, publishedAt: true } })
  return rows.sort((a, b) => b.publishedAt - a.publishedAt || (a.id < b.id ? 1 : -1)).map(r => r.id)
}

test("CHV-S10-M05 a collection returns only its published members, newest first, ties by ID", async () => {
  const res = await page("ethnic-festive")
  assert.equal(res.status, 200)
  assert.deepEqual(Object.keys(res.json).sort(), ["data", "page"])
  assert.deepEqual(Object.keys(res.json.data).sort(), [...PUBLIC_COLLECTION_PAGE_FIELDS].sort())
  assert.deepEqual(Object.keys(res.json.data.collection).sort(), [...PUBLIC_COLLECTION_FIELDS].sort())
  assert.deepEqual(res.json.data.collection, { version: 1, id: ethnic.id, handle: "ethnic-festive", title: ethnic.title, hidden: false })
  const order = await expectedOrder()
  assert.deepEqual(res.json.data.products.map(p => p.id), order)
  assert.deepEqual(order, [members[3].id, ...[members[1].id, members[2].id].sort().reverse(), members[0].id], "D newest, B and C by ID, A oldest")
  for (const p of res.json.data.products) {
    assert.deepEqual(Object.keys(p).sort(), [...PUBLIC_PRODUCT_FIELDS].sort())
    assert.ok(p.collectionIds.includes(ethnic.id))
  }
  assert.equal(res.json.page.nextCursor, null)
  for (const [kind, p] of Object.entries(excluded)) assert.ok(!res.text.includes(p.id) && !res.text.includes(p.handle), `${kind} absent`)
  // The product list filtered by collection agrees with the collection page.
  const list = await direct("/api/v1/catalogue/products?collection=ethnic-festive")
  assert.deepEqual(list.json.data.map(p => p.id), order)
})

test("CHV-S10-M05 membership is per collection, and a hidden collection is never named", async () => {
  const res = await page("dresses")
  assert.deepEqual(res.json.data.products.map(p => p.id), [members[3].id, excluded.otherCollection.id])
  const shared = res.json.data.products.find(p => p.id === members[3].id)
  assert.deepEqual(shared.collectionIds.sort(), [ethnic.id, dresses.id].sort(), "the hidden collection is left out of collectionIds")
  assert.deepEqual((await page("jewellery")).json.data.products, [], "a visible collection with no published members is an empty page")
})

test("CHV-S10-M05 pages are bounded and walk the members once in order", async () => {
  const order = await expectedOrder()
  const seen = []
  let cursor = null
  for (let i = 0; i < 10; i++) {
    const res = await page("ethnic-festive", `?limit=1${cursor ? `&cursor=${cursor}` : ""}`)
    assert.equal(res.status, 200)
    assert.equal(res.json.data.products.length <= 1, true)
    seen.push(...res.json.data.products.map(p => p.id))
    cursor = res.json.page.nextCursor
    if (!cursor) break
  }
  assert.deepEqual(seen, order)
  const two = await page("ethnic-festive", "?limit=2")
  assert.deepEqual(two.json.data.products.map(p => p.id), order.slice(0, 2))
  assert.deepEqual((await page("ethnic-festive", `?limit=2&cursor=${two.json.page.nextCursor}`)).json.data.products.map(p => p.id), order.slice(2))
  assert.equal((await page("ethnic-festive", "?limit=48")).status, 200)
  for (const bad of ["?limit=0", "?limit=49", "?limit=1000", "?limit=-1", "?limit=2.5", "?limit=x", `?cursor=${cursorOf({ publishedAt: "soon", id: members[0].id })}`, `?cursor=${cursorOf({ status: "draft" })}`, "?cursor=%7B%7D"]) {
    const res = await page("ethnic-festive", bad)
    assert.deepEqual([res.status, res.json.error?.code], [400, "invalid_request"], bad)
  }
})

test("CHV-S10-M05 query parameters cannot widen the filter or reorder the members", async () => {
  const order = await expectedOrder()
  for (const q of ["?status=draft", "?includeDrafts=1", "?sort=title", "?order=asc", "?collection=dresses"]) {
    const res = await page("ethnic-festive", q)
    assert.deepEqual([res.status, res.json.data.products.map(p => p.id)], [200, order], q)
  }
})

test("CHV-S10-M05 hidden and unknown collections are the same 404, and the key is required", async () => {
  const missing = await page("no-such-collection")
  assert.deepEqual([missing.status, missing.json], [404, { error: { code: "not_found", message: "not found" } }])
  const hid = await page(hidden.handle)
  assert.deepEqual([hid.status, hid.json], [missing.status, missing.json])
  assert.ok(!hid.text.includes(members[3].id))
  assert.equal((await page("Not_A_Handle")).status, 404)
  assert.equal((await c.api("GET", `/api/catalogue/collections/${hidden.handle}`)).status, 404, "same through the web host")
  assert.equal((await c.api("GET", "/api/catalogue/collections/ethnic-festive")).status, 200, "visible through the web host")
  assert.equal((await direct("/api/v1/catalogue/collections/ethnic-festive", { key: false })).status, 401)
})
