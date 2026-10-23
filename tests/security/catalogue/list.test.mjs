// CHV-S10-M03 (Stage 10.03): the public product list, called directly on the NestJS API (not through
// the web host), never returns a draft, unpublished, archived or uncounted product, whatever the
// query, cursor, page size or caller. Fixtures only: no real catalogue exists yet.
import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import { setup, staffWithMfa } from "../auth/helpers.mjs"
import { catalogueApi, countStock, fullChecklist, mediaStoreReady, png, readyDraft, sizes, uploadPhoto } from "./helpers.mjs"

const LIST = "/api/v1/catalogue/products"
let ctx, c, admin, owner, ethnic, hidden
const shown = {}
const secret = {}

/** A call straight to the API as the web host makes it (internal key), or as anyone else (no key). */
async function direct(path, { key = true, headers = {} } = {}) {
  const res = await fetch(ctx.api.url + path, { headers: { ...(key && { "x-chaanavya-internal-key": ctx.api.key }), ...headers } })
  const text = await res.text()
  return { status: res.status, text, json: text ? JSON.parse(text) : null }
}
const cursorOf = value => Buffer.from(JSON.stringify(value)).toString("base64url")

/** A product that passes every publish check, published by the owner; counted unless told not to. */
async function published(title, prefix, { count = true, collectionIds = [ethnic] } = {}) {
  const created = (await c.create(admin.jar, readyDraft(collectionIds, { title }))).json.data
  const saved = (await c.variants(admin.jar, created.id, created.etag, sizes(prefix))).json.data
  const photo = await uploadPhoto(c, admin.jar, created.id, png(600, 800))
  const approved = (await c.approve(owner.jar, photo.completed.json.data.media.at(-1).id, photo.completed.json.data.etag)).json.data
  const live = (await c.status(owner.jar, created.id, "publish", approved.etag, { reason: "list fixture", checklist: fullChecklist })).json.data
  if (count) await countStock(c, admin.jar, owner.jar, saved.variants.map(v => ({ sku: v.sku, counted: 2 })))
  return { ...live, skus: saved.variants.map(v => v.sku) }
}

before(async () => {
  await mediaStoreReady()
  ctx = await setup("chaanavya_test_s10_list")
  c = catalogueApi(ctx)
  admin = await staffWithMfa(ctx, "s10m03.admin@example.com", "ADMIN")
  owner = await staffWithMfa(ctx, "s10m03.owner@example.com", "OWNER")
  ethnic = (await ctx.db.collection.findUnique({ where: { handle: "ethnic-festive" } })).id
  hidden = (await c.createCollection(admin.jar, { handle: "m03-hidden", title: "M03 hidden" })).json.data
  const p = `M03${process.pid}`

  shown.first = await published("List kurta one", `${p}A`)
  shown.second = await published("List kurta two", `${p}B`)
  shown.third = await published("List kurta three", `${p}C`)

  // A complete draft whose stock was counted and signed: only publication keeps it hidden.
  const d = (await c.create(admin.jar, readyDraft([ethnic, hidden.id], { title: "List draft saree" }))).json.data
  const dv = (await c.variants(admin.jar, d.id, d.etag, sizes(`${p}D`))).json.data
  await countStock(c, admin.jar, owner.jar, dv.variants.map(v => ({ sku: v.sku, counted: 4 })))
  secret.draft = { ...d, skus: dv.variants.map(v => v.sku) }

  const unpub = await published("List unpublished kurta", `${p}U`)
  await c.status(owner.jar, unpub.id, "unpublish", (await c.get(owner.jar, unpub.id)).json.data.etag, { reason: "pulled from sale" })
  secret.unpublished = unpub

  const arch = await published("List archived kurta", `${p}R`)
  await c.status(owner.jar, arch.id, "archive", (await c.get(owner.jar, arch.id)).json.data.etag, { reason: "discontinued" })
  secret.archived = arch

  secret.uncounted = await published("List uncounted kurta", `${p}N`, { count: false })

  // Bypassing the API: active in the row but never published through the owner's checklist.
  const forged = await published("List forged kurta", `${p}F`)
  await ctx.db.product.update({ where: { id: forged.id }, data: { publishedAt: null } })
  secret.forged = forged

  for (const k of Object.keys(secret)) assert.equal((await ctx.db.product.findUnique({ where: { id: secret[k].id } })).status, k === "forged" || k === "uncounted" ? "active" : k === "archived" ? "archived" : "draft", `${k} fixture state`)
})
after(() => ctx?.teardown())

const ids = res => res.json.data.map(p => p.id)
const publicIds = () => [shown.third.id, shown.second.id, shown.first.id]
function assertNothingSecret(text, where) {
  for (const [kind, p] of Object.entries(secret)) {
    assert.ok(!text.includes(p.id), `${kind} product ID absent from ${where}`)
    assert.ok(!text.includes(p.handle), `${kind} handle absent from ${where}`)
    for (const sku of p.skus) assert.ok(!text.includes(sku), `${kind} SKU absent from ${where}`)
  }
}

test("CHV-S10-M03 the API refuses callers without the web host's key", async () => {
  const res = await direct(LIST, { key: false })
  assert.equal(res.status, 401)
  assert.deepEqual(res.json, { error: "unauthenticated" })
  assert.equal((await direct(LIST, { key: false, headers: { "x-chaanavya-internal-key": "guess" } })).status, 401)
})

test("CHV-S10-M03 called directly, the list holds only published, counted products, newest first", async () => {
  const res = await direct(LIST)
  assert.equal(res.status, 200)
  assert.deepEqual(ids(res), publicIds())
  assert.ok(res.json.data.every(p => p.status === "active"))
  assert.equal(res.json.page.nextCursor, null)
  assertNothingSecret(res.text, "the default list")
})

test("CHV-S10-M03 query parameters cannot widen the publication filter", async () => {
  for (const q of ["?status=draft", "?status=archived", "?status=draft&status=active", "?includeDrafts=true", "?preview=1", "?search=List%20draft", "?collection=ethnic-festive", "?collection=ethnic-festive&status=draft", "?limit=48"]) {
    const res = await direct(LIST + q)
    assert.equal(res.status, 200, q)
    assert.deepEqual(ids(res), publicIds(), q)
    assertNothingSecret(res.text, q)
  }
  // A hidden collection holding the draft is the same as an empty one.
  const res = await direct(`${LIST}?collection=${hidden.handle}`)
  assert.deepEqual([res.status, res.json.data], [200, []])
  for (const bad of ["?collection=..%2Fadmin", "?limit=0", "?limit=49", "?limit=abc"]) assert.notEqual((await direct(LIST + bad)).status, 200, bad)
})

test("CHV-S10-M03 paging one at a time visits each public product once and nothing else", async () => {
  const seen = []
  let cursor = null
  for (let page = 0; page < 10; page++) {
    const res = await direct(`${LIST}?limit=1${cursor ? `&cursor=${cursor}` : ""}`)
    assert.equal(res.status, 200)
    assertNothingSecret(res.text, `page ${page}`)
    seen.push(...ids(res))
    cursor = res.json.page.nextCursor
    if (!cursor) break
  }
  assert.deepEqual(seen, publicIds())
  const two = await direct(`${LIST}?limit=2`)
  assert.deepEqual(ids(two), publicIds().slice(0, 2))
  assert.deepEqual(ids(await direct(`${LIST}?limit=2&cursor=${two.json.page.nextCursor}`)), publicIds().slice(2))
})

test("CHV-S10-M03 a forged cursor is refused or only moves the position", async () => {
  const draftRow = await ctx.db.product.findUnique({ where: { id: secret.draft.id } })
  const future = { publishedAt: "2999-01-01T00:00:00.000Z", id: "ffffffff-ffff-7fff-bfff-ffffffffffff" }
  const res = await direct(`${LIST}?cursor=${cursorOf(future)}`)
  assert.deepEqual([res.status, ids(res)], [200, publicIds()], "a cursor after everything only restarts at the newest public product")
  const atDraft = await direct(`${LIST}?cursor=${cursorOf({ publishedAt: draftRow.createdAt.toISOString(), id: draftRow.id })}`)
  assert.equal(atDraft.status, 200)
  assertNothingSecret(atDraft.text, "a cursor pointing at the draft")
  for (const forged of [{ publishedAt: "not a date", id: draftRow.id }, { publishedAt: future.publishedAt, id: "1 OR 1=1" }, { publishedAt: future.publishedAt }, { status: "draft" }, [], "draft"]) {
    const bad = await direct(`${LIST}?cursor=${cursorOf(forged)}`)
    assert.equal(bad.status, 400, JSON.stringify(forged))
    assert.equal(bad.json.error.code, "invalid_request")
  }
  assert.equal((await direct(`${LIST}?cursor=${"%7B%7D"}`)).status, 400)
})

test("CHV-S10-M03 a signed-in owner gets the same public list, and hidden handles are a plain 404", async () => {
  const asOwner = await c.api("GET", "/api/catalogue/products", { jar: owner.jar })
  assert.deepEqual(ids(asOwner), publicIds(), "staff sessions do not reveal drafts in public reads")
  const missing = await direct("/api/v1/catalogue/products/no-such-product")
  assert.equal(missing.status, 404)
  for (const [kind, p] of Object.entries(secret)) {
    const res = await direct(`/api/v1/catalogue/products/${p.handle}`)
    assert.deepEqual([res.status, res.json], [missing.status, missing.json], `${kind} reads like a missing product`)
  }
})
