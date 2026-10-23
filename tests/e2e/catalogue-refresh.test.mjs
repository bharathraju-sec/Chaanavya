// CHV-S10-M10 (Stage 10.10), page part: a publish, a stock change or an unpublish becomes visible on
// the shop within the policy window. Real HTTP against the production build (`npm run build` first)
// with the normal 60 second cache: a change is NOT visible until the worker delivers its event (the
// pages are cached), and IS visible on the next page view after it. The worker's delivery job runs
// in-process against the real web host; the API runs in-process on a throwaway database.
// Fixtures only: no real catalogue exists yet.
import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { ROOT } from "../integration/database/helpers.mjs"
import { setup, staffWithMfa } from "../security/auth/helpers.mjs"
import { catalogueApi, countStock, fullChecklist, mediaStoreReady, png, readyDraft, sizes, uploadPhoto } from "../security/catalogue/helpers.mjs"
import { createLogger } from "../../packages/shared/src/observability/logger.ts"
import { outboxJob } from "../../apps/worker/src/jobs/outbox.ts"
import { REFRESH_PATH, storefrontRefresh } from "../../apps/worker/src/jobs/storefront-refresh.ts"

const PORT = 5664
const WEB = `http://127.0.0.1:${PORT}`
let ctx, c, admin, owner, web, job, ethnic, product
let output = ""
const logger = createLogger({ level: "error" })

const get = async path => {
  const res = await fetch(WEB + path, { headers: { accept: "text/html" }, redirect: "manual" })
  return { status: res.status, html: (await res.text()).replaceAll("&amp;", "&").replaceAll("&#x27;", "'") }
}
// The "New this week" grid only, so other copy cannot match.
const grid = html => html.slice(html.indexOf('id="new"'), html.indexOf("Silhouettes for every hour"))
const deliver = () => job.run(ctx.db)
const refresh = (headers = {}, method = "POST") => fetch(WEB + REFRESH_PATH, { method, headers, body: method === "POST" ? "{}" : undefined })

before(async () => {
  assert.ok(existsSync(join(ROOT, ".next", "BUILD_ID")), "run `npm run build` before the page tests")
  await mediaStoreReady()
  ctx = await setup("chaanavya_test_s10_cache")
  c = catalogueApi(ctx)
  admin = await staffWithMfa(ctx, "s10m10p.admin@example.com", "ADMIN")
  owner = await staffWithMfa(ctx, "s10m10p.owner@example.com", "OWNER")
  ethnic = (await ctx.db.collection.findUnique({ where: { handle: "ethnic-festive" } })).id
  job = outboxJob(logger, { "catalogue.updated": storefrontRefresh({ url: WEB, key: ctx.api.key }, logger) })

  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !["DATABASE_URL", "DIRECT_URL", "BETTER_AUTH_SECRET", "CATALOGUE_REVALIDATE_SECONDS"].includes(name)))
  // The normal cache time (60 seconds) is left in place on purpose.
  web = spawn(process.execPath, [join(ROOT, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)], {
    cwd: ROOT,
    env: { ...env, NODE_ENV: "production", APP_ENV: "development", API_URL: ctx.api.url, API_INTERNAL_KEY: ctx.api.key },
  })
  web.stdout.on("data", d => (output += d))
  web.stderr.on("data", d => (output += d))
  for (let i = 0; i < 60; i++) {
    try {
      if ((await get("/")).status === 200) return
    } catch {
      /* not up yet */
    }
    await new Promise(r => setTimeout(r, 1000))
  }
  throw new Error(`next start did not come up:\n${output.slice(-1500)}`)
})
after(async () => {
  web?.kill()
  await ctx?.teardown()
})

test("CHV-S10-M10 the refresh route answers only the worker, and only to POST", async () => {
  assert.equal((await refresh()).status, 404, "no key")
  assert.equal((await refresh({ "x-chaanavya-internal-key": "not-the-key" })).status, 404, "wrong key")
  assert.equal((await refresh({ "x-chaanavya-internal-key": ctx.api.key.slice(0, -1) })).status, 404, "nearly the key")
  assert.ok([404, 405].includes((await refresh({ "x-chaanavya-internal-key": ctx.api.key }, "GET")).status), "GET does nothing")
  const ok = await refresh({ "x-chaanavya-internal-key": ctx.api.key })
  assert.deepEqual([ok.status, await ok.json()], [200, { ok: true }])
  assert.equal(ok.headers.get("cache-control"), "no-store")
})

test("CHV-S10-M10 policy: public reads are cached for a bounded 60 seconds", async () => {
  const res = await c.publicList()
  assert.match(res.response.headers.get("cache-control"), /public, max-age=60/)
})

test("CHV-S10-M10 a publish becomes visible after the worker delivers it, not before", async () => {
  assert.match(grid((await get("/")).html), /New arrivals will appear here soon\./, "the shop starts empty")

  const created = (await c.create(admin.jar, readyDraft([ethnic], { title: "Cache kurta" }))).json.data
  const saved = (await c.variants(admin.jar, created.id, created.etag, sizes(`CA${process.pid}`))).json.data
  const photo = await uploadPhoto(c, admin.jar, created.id, png(600, 800))
  const approved = (await c.approve(owner.jar, photo.completed.json.data.media.at(-1).id, photo.completed.json.data.etag)).json.data
  product = (await c.status(owner.jar, created.id, "publish", approved.etag, { reason: "cache fixture", checklist: fullChecklist })).json.data
  product.variants = saved.variants
  await countStock(c, admin.jar, owner.jar, saved.variants.map((v, i) => ({ sku: v.sku, counted: i === 0 ? 2 : 0 })))
  assert.equal((await c.publicGet(product.handle)).status, 200, "the API already serves it")

  assert.match(grid((await get("/")).html), /New arrivals will appear here soon\./, "the cached page has not changed yet")
  const outcome = await deliver()
  assert.ok(outcome.delivered >= 2 && outcome.failed === 0, JSON.stringify(outcome))
  const after = grid((await get("/")).html)
  assert.match(after, /Cache kurta/, "visible on the next view after delivery")
  assert.match(after, /Quick add/)
  assert.equal((await get(`/products/${product.handle}`)).status, 200)
})

test("CHV-S10-M10 a stock change to sold out becomes visible after the worker delivers it", async () => {
  const s = product.variants[0]
  const stock = (await c.api("GET", `/api/admin/inventory/stock/${s.id}`, { jar: admin.jar })).json.data
  const wrote = await c.api("POST", `/api/admin/inventory/stock/${s.id}/write-off`, { jar: admin.jar, etag: stock.etag, body: { quantity: 2, reasonCode: "sample", reason: "both units used as samples" } })
  assert.equal(wrote.status, 200)
  assert.equal((await c.publicGet(product.handle)).json.data.variants.every(v => !v.availableForSale), true, "the API says sold out")

  assert.match(grid((await get("/")).html), /Quick add/, "the cached page still offers it")
  assert.match((await get(`/products/${product.handle}`)).html, /Select size|Add to bag/, "so does the cached product page")
  assert.ok((await deliver()).delivered >= 1)
  assert.match(grid((await get("/")).html), /Currently unavailable/)
  assert.ok(!/Quick add/.test(grid((await get("/")).html)))
  assert.match((await get(`/products/${product.handle}`)).html, /Currently unavailable/)
})

test("CHV-S10-M10 an unpublish removes the product after the worker delivers it", async () => {
  const etag = (await c.get(owner.jar, product.id)).json.data.etag
  assert.equal((await c.status(owner.jar, product.id, "unpublish", etag, { reason: "pulled from sale" })).status, 200)
  assert.equal((await c.publicGet(product.handle)).status, 404, "the API already hides it")

  assert.match(grid((await get("/")).html), /Cache kurta/, "the cached page still lists it")
  assert.ok((await deliver()).delivered >= 1)
  assert.match(grid((await get("/")).html), /New arrivals will appear here soon\./)
  assert.equal((await get(`/products/${product.handle}`)).status, 404)
})
