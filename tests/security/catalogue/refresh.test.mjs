// CHV-S10-M10 (Stage 10.10), API and worker part: a publish or a stock change writes a catalogue
// event in the same transaction (one per burst, never for products that are not live), and the worker
// turns events into one key-protected refresh request to the web host, retrying when it is down.
// Fixtures only: no real catalogue exists yet.
import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { setup, staffWithMfa } from "../auth/helpers.mjs"
import { catalogueApi, countStock, fullChecklist, mediaStoreReady, png, readyDraft, sizes, uploadPhoto } from "./helpers.mjs"
import { createLogger } from "../../../packages/shared/src/observability/logger.ts"
import { outboxJob } from "../../../apps/worker/src/jobs/outbox.ts"
import { REFRESH_PATH, storefrontRefresh, storefrontTarget } from "../../../apps/worker/src/jobs/storefront-refresh.ts"

let ctx, c, admin, owner, ethnic
const logger = createLogger({ level: "error" })

const inv = (method, path, jar, body, etag) => c.api(method, `/api/admin/inventory${path}`, { jar, body, etag })
const events = id => ctx.db.outboxEvent.findMany({ where: { topic: "catalogue.updated", aggregateId: id }, orderBy: { createdAt: "asc" } })
const pending = async id => (await events(id)).filter(e => !e.dispatchedAt)
const changes = async id => (await events(id)).map(e => e.payload.change)
const markAllDispatched = () => ctx.db.outboxEvent.updateMany({ where: { dispatchedAt: null }, data: { dispatchedAt: new Date() } })

async function live(title, prefix, { count = true } = {}) {
  const created = (await c.create(admin.jar, readyDraft([ethnic], { title }))).json.data
  const saved = (await c.variants(admin.jar, created.id, created.etag, sizes(prefix))).json.data
  const photo = await uploadPhoto(c, admin.jar, created.id, png(600, 800))
  const approved = (await c.approve(owner.jar, photo.completed.json.data.media.at(-1).id, photo.completed.json.data.etag)).json.data
  const published = (await c.status(owner.jar, created.id, "publish", approved.etag, { reason: "refresh fixture", checklist: fullChecklist })).json.data
  if (count) await countStock(c, admin.jar, owner.jar, saved.variants.map(v => ({ sku: v.sku, counted: 5 })))
  return { ...published, variants: saved.variants }
}
const stockOf = async (jar, variantId) => (await inv("GET", `/stock/${variantId}`, jar)).json.data

before(async () => {
  await mediaStoreReady()
  ctx = await setup("chaanavya_test_s10_refresh")
  c = catalogueApi(ctx)
  admin = await staffWithMfa(ctx, "s10m10.admin@example.com", "ADMIN")
  owner = await staffWithMfa(ctx, "s10m10.owner@example.com", "OWNER")
  ethnic = (await ctx.db.collection.findUnique({ where: { handle: "ethnic-festive" } })).id
})
after(() => ctx?.teardown())

test("CHV-S10-M10 a publish and a signed count each announce, and a burst of stock changes is one event", async () => {
  const p = await live("Refresh kurta", `RF${process.pid}A`)
  const first = await changes(p.id)
  assert.equal(first[0], "published", "the publish is announced")
  assert.equal(first.filter(x => x === "stock").length, 1, "the signed count of both sizes is one stock event, not one per movement")

  await markAllDispatched()
  const [s, m] = p.variants
  let stock = await stockOf(admin.jar, s.id)
  stock = (await inv("POST", `/stock/${s.id}/write-off`, admin.jar, { quantity: 1, reasonCode: "damaged", reason: "damaged in handling" }, stock.etag)).json.data
  assert.equal((await pending(p.id)).length, 1, "a write-off announces")
  stock = (await inv("POST", `/stock/${s.id}/receive`, admin.jar, { quantity: 2, reason: "delivery" }, stock.etag)).json.data
  const other = await stockOf(admin.jar, m.id)
  await inv("POST", `/stock/${m.id}/adjust`, admin.jar, { delta: 1, reasonCode: "found", reason: "found on the shelf" }, other.etag)
  assert.equal((await pending(p.id)).length, 1, "three more changes before delivery are still one pending event")
  const [event] = await pending(p.id)
  assert.deepEqual(Object.keys(event.payload).sort(), ["change", "collections", "handle", "productId"], "the event holds no stock numbers or private fields")
  assert.equal(event.payload.change, "stock")
  assert.deepEqual(event.payload.collections, ["ethnic-festive"])
})

test("CHV-S10-M10 a signed count that moves no stock still announces, because it can make the product public", async () => {
  const p = await live("Refresh matching count", `RF${process.pid}B`, { count: false })
  await markAllDispatched()
  const lines = p.variants.map(v => ({ sku: v.sku, counted: 0 })) // books say 0, count says 0: no movement
  await countStock(c, admin.jar, owner.jar, lines)
  const movements = await ctx.db.inventoryMovement.count({ where: { variantId: { in: p.variants.map(v => v.id) } } })
  assert.equal(movements, 0, "no movement was needed")
  assert.deepEqual((await pending(p.id)).map(e => e.payload.change), ["stock"])
  assert.equal((await c.publicGet(p.handle)).status, 200, "and the product is public now")
})

test("CHV-S10-M10 an unpublish announces, and nothing is announced for a product that is not live", async () => {
  const p = await live("Refresh unpublished", `RF${process.pid}C`)
  await markAllDispatched()
  const etag = (await c.get(owner.jar, p.id)).json.data.etag
  await c.status(owner.jar, p.id, "unpublish", etag, { reason: "pulled from sale" })
  assert.deepEqual((await pending(p.id)).map(e => e.payload.change), ["unpublished"])

  // A draft: stock work on its SKUs leaves no event, so events never reveal unpublished products.
  const draft = (await c.create(admin.jar, readyDraft([ethnic], { title: "Refresh draft saree" }))).json.data
  const saved = (await c.variants(admin.jar, draft.id, draft.etag, sizes(`RF${process.pid}D`))).json.data
  const stock = await stockOf(admin.jar, saved.variants[0].id)
  await inv("POST", `/stock/${saved.variants[0].id}/receive`, admin.jar, { quantity: 3, reason: "delivery" }, stock.etag)
  assert.deepEqual(await events(draft.id), [], "no event for a draft")
  // Stock work on the unpublished product does not announce either.
  const again = await stockOf(admin.jar, p.variants[0].id)
  await inv("POST", `/stock/${p.variants[0].id}/receive`, admin.jar, { quantity: 1, reason: "delivery" }, again.etag)
  assert.deepEqual((await pending(p.id)).map(e => e.payload.change), ["unpublished"])
})

// ---- the worker's refresh handler and delivery job ------------------------------------------------

let stub, base, answer, seen
before(async () => {
  stub = createServer((req, res) => {
    let body = ""
    req.on("data", d => (body += d))
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, key: req.headers["x-chaanavya-internal-key"], body })
      res.writeHead(answer, { "content-type": "application/json" }).end("{}")
    })
  })
  await new Promise(r => stub.listen(0, "127.0.0.1", r))
  base = `http://127.0.0.1:${stub.address().port}`
})
after(() => new Promise(r => (stub ? stub.close(r) : r())))

test("CHV-S10-M10 the handler makes one key-protected request that carries nothing about the catalogue", async () => {
  seen = []
  answer = 200
  const handler = storefrontRefresh({ url: base, key: "worker-test-key" }, logger)
  await handler({ id: "e1", topic: "catalogue.updated", aggregateId: "p1", payload: { change: "stock" }, attempts: 0, createdAt: new Date(Date.now() - 5000) }, logger)
  assert.equal(seen.length, 1)
  assert.deepEqual([seen[0].method, seen[0].url, seen[0].key], ["POST", REFRESH_PATH, "worker-test-key"])
  assert.deepEqual(JSON.parse(seen[0].body), { tag: "catalogue" })
  // Events created before that refresh started are already covered by it.
  await handler({ id: "e2", topic: "catalogue.updated", aggregateId: "p2", payload: {}, attempts: 0, createdAt: new Date(Date.now() - 4000) }, logger)
  assert.equal(seen.length, 1, "an earlier event needs no second request")
  await new Promise(r => setTimeout(r, 20))
  await handler({ id: "e3", topic: "catalogue.updated", aggregateId: "p3", payload: {}, attempts: 0, createdAt: new Date() }, logger)
  assert.equal(seen.length, 2, "a newer event needs a new refresh")
})

test("CHV-S10-M10 an error answer, an unreachable web host and a missing setting fail the event so it is retried", async () => {
  const event = { id: "e", topic: "catalogue.updated", aggregateId: "p", payload: {}, attempts: 0 }
  answer = 500
  await assert.rejects(storefrontRefresh({ url: base, key: "k" }, logger)(event, logger), /answered 500/)
  await assert.rejects(storefrontRefresh({ url: "http://127.0.0.1:1", key: "k" }, logger)(event, logger))
  await assert.rejects(storefrontRefresh(null, logger)(event, logger), /not configured/)
  assert.deepEqual(storefrontTarget({}), { url: "http://127.0.0.1:3000", key: "development-only-internal-key-not-a-secret" }, "development defaults")
  assert.deepEqual(storefrontTarget({ APP_ENV: "production", WEB_URL: "https://shop.example/", API_INTERNAL_KEY: "k".repeat(32) }), { url: "https://shop.example", key: "k".repeat(32) })
  assert.equal(storefrontTarget({ APP_ENV: "production", API_INTERNAL_KEY: "k".repeat(32) }), null, "no WEB_URL outside development")
  assert.equal(storefrontTarget({ APP_ENV: "staging", WEB_URL: "https://shop.example" }), null, "no key outside development")
})

test("CHV-S10-M10 the delivery job refreshes once for many events, keeps events when the web host is down and delivers them when it is back", async () => {
  await markAllDispatched()
  const p = await live("Refresh job kurta", `RF${process.pid}E`)
  assert.ok((await pending(p.id)).length >= 2, "a publish and a stock event are waiting")
  const job = outboxJob(logger, { "catalogue.updated": storefrontRefresh({ url: base, key: "job-key" }, logger) })

  seen = []
  answer = 500
  assert.deepEqual(await job.run(ctx.db), { delivered: 0, failed: (await pending(p.id)).length })
  const failed = await pending(p.id)
  assert.ok(failed.every(e => e.attempts === 1 && /answered 500/.test(e.lastError) && e.availableAt > new Date()), "kept, with the error and a later retry time")

  answer = 200
  seen = []
  await ctx.db.outboxEvent.updateMany({ where: { dispatchedAt: null }, data: { availableAt: new Date() } })
  const outcome = await job.run(ctx.db)
  assert.equal(outcome.failed, 0)
  assert.ok(outcome.delivered >= 2)
  assert.equal(seen.length, 1, "all waiting events were covered by one refresh")
  assert.deepEqual(await pending(p.id), [])
  assert.equal(seen[0].key, "job-key")
  assert.deepEqual(await job.run(ctx.db), { delivered: 0, failed: 0 }, "nothing is delivered twice")
})
