// CHV-S10-M11 (Stage 10.11): the Stage 10 gate. The public catalogue passes SEO and route checks and
// serves only published, counted products from the NestJS API, while checkout stays closed. Real HTTP
// against the production build (`npm run build` first): `next start` gets only the API's address and
// key; the API runs in-process on a throwaway database with fixtures. Fixtures only: no real
// catalogue exists yet.
import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { ROOT } from "../integration/database/helpers.mjs"
import { setup, staffWithMfa } from "../security/auth/helpers.mjs"
import { catalogueApi, countStock, fullChecklist, mediaStoreReady, png, readyDraft, sizes, uploadPhoto } from "../security/catalogue/helpers.mjs"
import { createLogger } from "../../packages/shared/src/observability/logger.ts"
import { outboxJob } from "../../apps/worker/src/jobs/outbox.ts"
import { storefrontRefresh } from "../../apps/worker/src/jobs/storefront-refresh.ts"
import { fallbackProducts } from "../../lib/catalog.ts"
import { visibleCollections } from "../../lib/collections.ts"

const PORT = 5665
const WEB = `http://127.0.0.1:${PORT}`
const SITE = "https://chaanavya.in"
const INFO = ["/contact", "/size-guide", "/track-order", "/shipping-policy", "/refund-policy", "/privacy-policy", "/terms"]
let ctx, c, admin, owner, web, job
let output = ""
const made = {}
const logger = createLogger({ level: "error" })

const get = async (path, options = {}) => {
  const res = await fetch(WEB + path, { headers: { accept: "text/html" }, redirect: "manual", ...options })
  return { status: res.status, headers: res.headers, text: await res.text() }
}
const decode = text => text.replaceAll("&amp;", "&").replaceAll("&#x27;", "'").replaceAll("&quot;", '"')
const locs = xml => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1].replace(SITE, "")).map(p => p || "/")
const robotsMeta = html => decode(html).match(/<meta name="robots" content="([^"]*)"/)?.[1] ?? null
const canonical = html => decode(html).match(/<link rel="canonical" href="([^"]*)"/)?.[1] ?? null

async function publish(title, prefix, collectionIds, { count = true } = {}) {
  const created = (await c.create(admin.jar, readyDraft(collectionIds, { title }))).json.data
  const saved = (await c.variants(admin.jar, created.id, created.etag, sizes(prefix))).json.data
  const photo = await uploadPhoto(c, admin.jar, created.id, png(600, 800), { altText: `${title} front view` })
  const approved = (await c.approve(owner.jar, photo.completed.json.data.media.at(-1).id, photo.completed.json.data.etag)).json.data
  const live = (await c.status(owner.jar, created.id, "publish", approved.etag, { reason: "gate fixture", checklist: fullChecklist })).json.data
  if (count) await countStock(c, admin.jar, owner.jar, saved.variants.map((v, i) => ({ sku: v.sku, counted: i === 0 ? 2 : 0 })))
  return live
}
const statusTo = async (p, action, reason) => c.status(owner.jar, p.id, action, (await c.get(owner.jar, p.id)).json.data.etag, { reason })

before(async () => {
  assert.ok(existsSync(join(ROOT, ".next", "BUILD_ID")), "run `npm run build` before the page tests")
  await mediaStoreReady()
  ctx = await setup("chaanavya_test_s10_gate")
  c = catalogueApi(ctx)
  admin = await staffWithMfa(ctx, "s10m11.admin@example.com", "ADMIN")
  owner = await staffWithMfa(ctx, "s10m11.owner@example.com", "OWNER")
  const id = async handle => (await ctx.db.collection.findUnique({ where: { handle } })).id
  const ids = { ethnic: await id("ethnic-festive"), dresses: await id("dresses") }
  const p = `GT${process.pid}`

  made.e1 = await publish("Gate kurta one", `${p}A`, [ids.ethnic])
  made.e2 = await publish("Gate kurta two", `${p}B`, [ids.ethnic])
  made.d1 = await publish("Gate dress one", `${p}C`, [ids.dresses])
  made.draft = (await c.create(admin.jar, readyDraft([ids.ethnic], { title: "Gate draft saree" }))).json.data
  made.uncounted = await publish("Gate uncounted kurta", `${p}U`, [ids.ethnic], { count: false })
  made.forged = await publish("Gate forged kurta", `${p}F`, [ids.ethnic])
  await ctx.db.product.update({ where: { id: made.forged.id }, data: { publishedAt: null } })
  made.unpublished = await publish("Gate unpublished kurta", `${p}N`, [ids.ethnic])
  await statusTo(made.unpublished, "unpublish", "pulled from sale")
  made.archived = await publish("Gate archived kurta", `${p}R`, [ids.ethnic])
  await statusTo(made.archived, "archive", "discontinued")
  // 49 more products in dresses: the collection pages (48 per page) and the sitemap pages.
  made.bulk = []
  for (let i = 0; i < 49; i++) {
    const handle = `gate-bulk-${String(i).padStart(2, "0")}`
    made.bulk.push(handle)
    await ctx.db.product.create({
      data: {
        handle,
        title: `Gate bulk ${String(i).padStart(2, "0")}`,
        status: "active",
        publishedAt: new Date(Date.now() - 3_600_000 - i * 1000),
        collections: { create: [{ collectionId: ids.dresses }] },
        variants: { create: [{ sku: `GTBULK${process.pid}-${i}`, title: "One Size", optionKey: "default", pricePaise: 150000n, taxCategory: "apparel", balance: { create: { onHand: 1, lastCountedAt: new Date() } } }] },
      },
    })
  }
  // The owner hides the fragrance collection; jewellery stays visible but empty.
  await ctx.db.collection.update({ where: { handle: "fragrance" }, data: { hidden: true } })
  job = outboxJob(logger, { "catalogue.updated": storefrontRefresh({ url: WEB, key: ctx.api.key }, logger) })

  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !["DATABASE_URL", "DIRECT_URL", "BETTER_AUTH_SECRET", "CATALOGUE_REVALIDATE_SECONDS"].includes(name)))
  web = spawn(process.execPath, [join(ROOT, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)], {
    cwd: ROOT,
    env: { ...env, NODE_ENV: "production", APP_ENV: "development", API_URL: ctx.api.url, API_INTERNAL_KEY: ctx.api.key },
  })
  web.stdout.on("data", d => (output += d))
  web.stderr.on("data", d => (output += d))
  for (let i = 0; i < 60; i++) {
    try {
      if ((await get("/robots.txt")).status === 200) return
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

test("CHV-S10-M11 the sitemap lists exactly what shoppers can open, and nothing hidden or sample", async () => {
  const res = await get("/sitemap.xml")
  assert.equal(res.status, 200)
  assert.match(res.headers.get("content-type"), /xml/)
  const urls = locs(res.text)
  assert.equal(new Set(urls).size, urls.length, "no URL twice")
  const products = urls.filter(u => u.startsWith("/products/")).map(u => u.slice("/products/".length)).sort()
  assert.deepEqual(products, [made.e1.handle, made.e2.handle, made.d1.handle, ...made.bulk].sort(), "published, counted products only (52, across two sitemap reads of 48)")
  for (const p of [made.draft, made.uncounted, made.forged, made.unpublished, made.archived]) assert.ok(!urls.some(u => u.includes(p.handle)), `${p.handle} is absent`)
  for (const sample of fallbackProducts) assert.ok(!urls.includes(`/products/${sample.handle}`), `sample ${sample.handle} is absent`)
  const pages = urls.filter(u => !u.startsWith("/products/")).sort()
  assert.deepEqual(pages, ["/", "/dresses", "/ethnic-festive", "/new-arrivals", ...INFO].sort(), "home, collections that have products, and the information pages")
  assert.ok(!urls.includes("/jewellery"), "an empty collection is not listed")
  assert.ok(!urls.includes("/fragrance"), "a collection the owner hid is not listed")
  for (const u of urls) assert.ok(!/^\/(admin|account|api|checkout|cart)/.test(u), `${u} is not a private or checkout path`)
})

test("CHV-S10-M11 robots.txt keeps private paths out and points at the sitemap", async () => {
  const text = (await get("/robots.txt")).text
  assert.match(text, /User-Agent: \*/i)
  assert.match(text, /Allow: \//)
  for (const path of ["/api/", "/account", "/admin"]) assert.match(text, new RegExp(`Disallow: ${path}`))
  assert.match(text, /Sitemap: https:\/\/chaanavya\.in\/sitemap\.xml/)
  assert.ok(!/Disallow: \/(products|ethnic-festive|dresses|jewellery|fragrance|new-arrivals)/.test(text), "no catalogue page is blocked")
})

test("CHV-S10-M11 every listed page opens, is mobile-ready, has a title and its own canonical address, and names no sample product", async () => {
  const urls = locs((await get("/sitemap.xml")).text)
  const sample = [...urls.filter(u => !u.startsWith("/products/")), ...urls.filter(u => u.startsWith("/products/")).slice(0, 4)]
  for (const path of sample) {
    const res = await get(path)
    assert.equal(res.status, 200, path)
    const html = decode(res.text)
    assert.match(html, /<title>[^<]+<\/title>/, `${path} has a title`)
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1"/, `${path} is mobile-ready`)
    assert.ok(!/user-scalable=no|maximum-scale=1\b/.test(html), `${path} lets shoppers zoom`)
    assert.equal(canonical(res.text), path === "/" ? SITE : SITE + path, `${path} names itself as its canonical address`)
    assert.equal(robotsMeta(res.text)?.includes("noindex") ?? false, false, `${path} is indexable`)
    for (const s of fallbackProducts) assert.ok(!html.includes(`/products/${s.handle}`), `${path} names no sample product (${s.handle})`)
  }
})

test("CHV-S10-M11 an empty collection and the Show more pages are kept out of the index, with one canonical address", async () => {
  const empty = await get("/jewellery")
  assert.equal(empty.status, 200, "the page still opens")
  assert.match(robotsMeta(empty.text) ?? "", /noindex/)
  assert.ok(canonical(empty.text)?.endsWith("/jewellery"))
  const filled = await get("/dresses")
  assert.equal(robotsMeta(filled.text)?.includes("noindex") ?? false, false, "a collection with products is indexable")
  const more = decode(filled.text).match(/href="(\/dresses\?cursor=[^"]+)"/)
  assert.ok(more, "52 dresses page at 48")
  const second = await get(more[1])
  assert.equal(second.status, 200)
  assert.match(robotsMeta(second.text) ?? "", /noindex/)
  assert.ok(canonical(second.text)?.endsWith("/dresses") && !canonical(second.text).includes("cursor"), "the second page's canonical is the first page")
  // Product pages: one canonical address, and a variant link does not make a new page.
  const product = await get(`/products/${made.e1.handle}?variant=${"0".repeat(8)}-0000-7000-8000-${"0".repeat(12)}`)
  assert.ok(canonical(product.text)?.endsWith(`/products/${made.e1.handle}`) && !canonical(product.text).includes("variant"))
  assert.equal(robotsMeta(product.text)?.includes("noindex") ?? false, false)
})

test("CHV-S10-M11 the sitemap follows the catalogue: an unpublish drops the product after the worker delivers it", async () => {
  assert.ok(locs((await get("/sitemap.xml")).text).includes(`/products/${made.e2.handle}`))
  assert.equal((await statusTo(made.e2, "unpublish", "pulled from sale")).status, 200)
  assert.ok(locs((await get("/sitemap.xml")).text).includes(`/products/${made.e2.handle}`), "the cached sitemap has not changed yet")
  assert.ok((await job.run(ctx.db)).delivered >= 1)
  const urls = locs((await get("/sitemap.xml")).text)
  assert.ok(!urls.includes(`/products/${made.e2.handle}`), "gone after delivery")
  assert.ok(urls.includes("/ethnic-festive"), "its collection still has e1")
  assert.equal((await get(`/products/${made.e2.handle}`)).status, 404)
})

// Since Stage 11.02 the bag has an API (/api/cart: read, add, change a quantity); checkout, payment,
// webhooks and quotes stay closed until their own stages.
test("CHV-S10-M11 checkout stays closed: no checkout, payment or webhook route, page or API, and no payment provider on the pages", async () => {
  // Since Stage 12.11 /checkout is the order review page in development and staging (this server runs as
  // development); production answers 404 (tests/e2e/checkout-review.test.mjs).
  for (const path of ["/cart", "/payment", "/payments", "/order", "/orders", "/api/checkout", "/api/payments", "/api/cart", "/api/webhooks/razorpay", "/api/orders"]) {
    const res = await get(path, { method: path.startsWith("/api") ? "POST" : "GET", body: path.startsWith("/api") ? "{}" : undefined })
    assert.ok([401, 404, 405].includes(res.status), `${path} answered ${res.status}`)
    assert.notEqual(res.status, 200, `${path} must not exist`)
  }
  for (const path of ["/", `/products/${made.e1.handle}`, "/dresses"]) {
    const html = (await get(path)).text.toLowerCase()
    for (const provider of ["razorpay", "phonepe", "shiprocket", "cdn.shopify", "myshopify"]) assert.ok(!html.includes(provider), `${path} loads no ${provider}`)
  }
  const api = JSON.parse(readFileSync(join(ROOT, "packages/contracts/openapi/api.json"), "utf8"))
  // Stage 12.09 and 12.10 add the quote preview and its check, which price the bag and place no order, take no payment
  // and reserve nothing (tests/security/checkout/quote*.test.mjs). Every other such path stays closed.
  assert.deepEqual(Object.keys(api.paths).filter(p => /checkout|payment|webhook|quote/i.test(p) && p !== "/api/v1/cart/quote" && p !== "/api/v1/cart/quote/{quoteId}"), [], "the API has no checkout or payment path")
  // The bag's checkout button is a disabled placeholder where checkout is closed. Only the bag links to the
  // review page, and only when it is open (Stage 12.11); nothing links to a checkout API.
  const sheet = readFileSync(join(ROOT, "components/cart/cart-sheet.tsx"), "utf8")
  assert.match(sheet, /Checkout opens soon/)
  assert.match(sheet, /<Button[^>]*disabled[^>]*>\s*Checkout opens soon/s)
  const walk = dir => readdirSync(dir).flatMap(e => (statSync(join(dir, e)).isDirectory() ? (e === "admin" ? [] : walk(join(dir, e))) : [join(dir, e)]))
  for (const file of ["app", "components", "lib"].flatMap(d => walk(join(ROOT, d))).filter(f => /\.(ts|tsx)$/.test(f))) {
    const source = readFileSync(file, "utf8")
    assert.doesNotMatch(source, /\/api\/checkout/, `${relative(ROOT, file)} calls a checkout API`)
    if (relative(ROOT, file).replaceAll("\\", "/") === "components/cart/cart-sheet.tsx") assert.match(source, /checkoutOpen && lines\.length > 0 \?[\s\S]*<Link href="\/checkout"/, "the bag links to the review only when open")
    else assert.doesNotMatch(source, /href=["'`]\/checkout|router\.push\(["'`]\/checkout/, `${relative(ROOT, file)} links to checkout`)
  }
})

test("CHV-S10-M11 when the API is down the sitemap and robots still work, with fixed pages only and no stale or sample product", async () => {
  await ctx.teardown()
  // Cached reads keep serving for up to 60 seconds while the API is down (by design); expire them the way the
  // worker's refresh does, so the outage view is what a visitor sees once the cache time has passed.
  const refreshed = await fetch(WEB + "/api/internal/revalidate", { method: "POST", headers: { "x-chaanavya-internal-key": ctx.api.key }, body: "{}" })
  assert.equal(refreshed.status, 200)
  const sitemap = await get("/sitemap.xml")
  assert.equal(sitemap.status, 200)
  const urls = locs(sitemap.text)
  assert.deepEqual(urls.sort(), ["/", ...INFO].sort(), "home and the information pages, no product and no catalogue collection")
  assert.equal((await get("/robots.txt")).status, 200)
  assert.equal((await get("/")).status, 200)
})
