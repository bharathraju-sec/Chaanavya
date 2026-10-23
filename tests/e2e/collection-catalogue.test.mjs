// CHV-S10-M08 (Stage 10.08): the collection pages show a collection's published products from the
// NestJS API, with the right items in the right order, honest empty states and the existing slugs and
// redirects, and never the placeholder catalogue. Real HTTP against the production build (`npm run
// build` first): `next start` gets only the API's address and key; the API runs in-process on a
// throwaway database with fixtures. Fixtures only: no real catalogue exists yet.
import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { ROOT } from "../integration/database/helpers.mjs"
import { setup, staffWithMfa } from "../security/auth/helpers.mjs"
import { catalogueApi, countStock, fullChecklist, mediaStoreReady, png, readyDraft, sizes, uploadPhoto } from "../security/catalogue/helpers.mjs"
import { fallbackProducts } from "../../lib/catalog.ts"
import { visibleCollections } from "../../lib/collections.ts"

const PORT = 5662
let ctx, c, admin, owner, web, ids
let output = ""
let apiClosed = false
const made = {}

const get = async (path, options = {}) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { headers: { accept: "text/html" }, redirect: "manual", ...options })
  return { status: res.status, location: res.headers.get("location"), html: await res.text() }
}
const decode = html => html.replaceAll("&amp;", "&").replaceAll("&#x27;", "'").replaceAll("&quot;", '"')
// Only the products part of a collection page (up to the footer): the hero and group copy and the header search data cannot match.
const productsPart = html => decode(html.slice(html.indexOf('id="collection"'), html.indexOf("<footer")))
const titlesIn = (html, pattern) => [...productsPart(html).matchAll(pattern)].map(m => m[0]).filter((t, i, all) => all.indexOf(t) === i)
const COPY = new Map(visibleCollections.map(x => [x.slug, x]))
const noSamples = html => {
  for (const p of fallbackProducts) assert.ok(!html.includes(`/products/${p.handle}`), `sample product ${p.handle} is absent`)
}

async function published(title, prefix, collectionIds, { count = true } = {}) {
  const created = (await c.create(admin.jar, readyDraft(collectionIds, { title }))).json.data
  const saved = (await c.variants(admin.jar, created.id, created.etag, sizes(prefix))).json.data
  const photo = await uploadPhoto(c, admin.jar, created.id, png(600, 800), { altText: `${title} front view` })
  const approved = (await c.approve(owner.jar, photo.completed.json.data.media.at(-1).id, photo.completed.json.data.etag)).json.data
  const result = (await c.status(owner.jar, created.id, "publish", approved.etag, { reason: "collection fixture", checklist: fullChecklist })).json.data
  if (count) await countStock(c, admin.jar, owner.jar, saved.variants.map((v, i) => ({ sku: v.sku, counted: i === 0 ? 3 : 0 })))
  return result
}

before(async () => {
  assert.ok(existsSync(join(ROOT, ".next", "BUILD_ID")), "run `npm run build` before the page tests")
  await mediaStoreReady()
  ctx = await setup("chaanavya_test_s10_collections")
  c = catalogueApi(ctx)
  admin = await staffWithMfa(ctx, "s10m08.admin@example.com", "ADMIN")
  owner = await staffWithMfa(ctx, "s10m08.owner@example.com", "OWNER")
  const id = async handle => (await ctx.db.collection.findUnique({ where: { handle } })).id
  ids = { ethnic: await id("ethnic-festive"), dresses: await id("dresses"), jewellery: await id("jewellery") }

  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !["DATABASE_URL", "DIRECT_URL", "BETTER_AUTH_SECRET"].includes(name)))
  web = spawn(process.execPath, [join(ROOT, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)], {
    cwd: ROOT,
    env: { ...env, NODE_ENV: "production", APP_ENV: "development", API_URL: ctx.api.url, API_INTERNAL_KEY: ctx.api.key, CATALOGUE_REVALIDATE_SECONDS: "0" },
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
  if (!apiClosed) await ctx?.teardown()
})

test("CHV-S10-M08 every collection page keeps its slug and editorial copy and shows an honest empty state", async () => {
  assert.deepEqual([...COPY.keys()].sort(), ["dresses", "ethnic-festive", "fragrance", "jewellery", "new-arrivals"], "the existing slugs")
  for (const [slug, page] of COPY) {
    const res = await get(`/${slug}`)
    assert.equal(res.status, 200, slug)
    const text = decode(res.html)
    assert.ok(text.includes(page.heading[0]) && text.includes(page.groups[0].heading), `${slug} keeps its editorial copy`)
    assert.ok(text.includes("No products are available in this collection yet."), `${slug} says it is empty`)
    assert.ok(!productsPart(res.html).includes("/products/"), `${slug} shows no product`)
    assert.ok(!/temporarily unavailable/.test(text), `${slug}: an empty collection is not an outage`)
    noSamples(res.html)
  }
})

test("CHV-S10-M08 each collection shows exactly its published members, newest first", async () => {
  made.e1 = await published("Collection kurta E1", `K${process.pid}E1`, [ids.ethnic])
  made.e2 = await published("Collection kurta E2", `K${process.pid}E2`, [ids.ethnic])
  made.b1 = await published("Collection both B1", `K${process.pid}B1`, [ids.ethnic, ids.dresses])
  made.d1 = await published("Collection dress D1", `K${process.pid}D1`, [ids.dresses])
  // Never shown anywhere: a draft, an uncounted product, and one marked active without being published.
  const draft = (await c.create(admin.jar, readyDraft([ids.ethnic], { title: "Collection draft saree" }))).json.data
  made.uncounted = await published("Collection uncounted kurta", `K${process.pid}UN`, [ids.ethnic], { count: false })
  const forged = await published("Collection forged kurta", `K${process.pid}FG`, [ids.ethnic])
  await ctx.db.product.update({ where: { id: forged.id }, data: { publishedAt: null } })
  const pattern = /Collection (?:kurta E\d|both B1|dress D1)/g

  const ethnic = await get("/ethnic-festive")
  assert.deepEqual(titlesIn(ethnic.html, pattern), ["Collection both B1", "Collection kurta E2", "Collection kurta E1"])
  const dresses = await get("/dresses")
  assert.deepEqual(titlesIn(dresses.html, pattern), ["Collection dress D1", "Collection both B1"])
  const fresh = await get("/new-arrivals")
  assert.deepEqual(titlesIn(fresh.html, pattern), ["Collection dress D1", "Collection both B1", "Collection kurta E2", "Collection kurta E1"], "new arrivals are the newest across the shop")
  for (const [name, page] of [["ethnic-festive", ethnic], ["dresses", dresses], ["new-arrivals", fresh]]) {
    const section = productsPart(page.html)
    for (const hidden of ["Collection draft saree", "Collection uncounted kurta", "Collection forged kurta", draft.handle, made.uncounted.handle, forged.handle]) assert.ok(!section.includes(hidden), `${name} omits ${hidden}`)
    assert.ok(!section.includes("No products are available"), `${name} is not shown as empty`)
    noSamples(page.html)
  }
  assert.ok(productsPart(ethnic.html).includes(`/products/${made.e1.handle}`), "cards link to the product")
  assert.ok(productsPart(ethnic.html).includes("₹2,499"), "the API's price, formatted as rupees")
  // A collection with no published member stays empty while others fill.
  assert.ok(decode((await get("/jewellery")).html).includes("No products are available in this collection yet."))
})

test("CHV-S10-M08 a collection with more than 48 products pages with Show more and no product is lost or repeated", async () => {
  const base = Date.now() - 3_600_000
  for (let i = 0; i < 49; i++) {
    await ctx.db.product.create({
      data: {
        handle: `bulk-piece-${String(i).padStart(2, "0")}`,
        title: `Bulk piece ${String(i).padStart(2, "0")}`,
        status: "active",
        publishedAt: new Date(base - i * 1000),
        collections: { create: [{ collectionId: ids.jewellery }] },
        variants: { create: [{ sku: `BULK${process.pid}-${i}`, title: "One Size", optionKey: "default", pricePaise: 150000n, taxCategory: "jewellery", balance: { create: { onHand: 1, lastCountedAt: new Date() } } }] },
      },
    })
  }
  const first = await get("/jewellery")
  assert.equal(first.status, 200)
  const bulk = html => titlesIn(html, /Bulk piece \d\d/g)
  const firstPage = bulk(first.html)
  assert.equal(firstPage.length, 48)
  assert.deepEqual([firstPage[0], firstPage.at(-1)], ["Bulk piece 00", "Bulk piece 47"])
  const more = decode(first.html).match(/href="(\/jewellery\?cursor=[^"]+)"/)
  assert.ok(more && /Show more/.test(productsPart(first.html)), "a Show more link points at the next page")
  const second = await get(more[1].replaceAll("&amp;", "&"))
  assert.equal(second.status, 200)
  assert.deepEqual(bulk(second.html), ["Bulk piece 48"], "the second page holds only what is left")
  assert.ok(!/Show more/.test(second.html), "the last page has no Show more")
  assert.ok(!decode(second.html).includes("No products are available"))
  assert.ok(!(await get("/dresses")).html.includes("Show more"), "small collections have no Show more")
})

test("CHV-S10-M08 a forged or malformed cursor is a plain 404, never a leak", async () => {
  const forged = value => Buffer.from(JSON.stringify(value)).toString("base64url")
  for (const cursor of ["%7Bbad", "not-a-cursor", forged({ status: "draft" }), forged({ publishedAt: "soon", id: made.e1.id }), forged([])]) {
    const res = await get(`/ethnic-festive?cursor=${cursor}`)
    assert.equal(res.status, 404, cursor)
    assert.ok(!res.html.includes('id="collection"'), "no collection grid is rendered")
  }
})

test("CHV-S10-M08 unknown slugs, an owner-hidden collection and the old links behave as before", async () => {
  assert.equal((await get("/no-such-collection")).status, 404)
  // Existing redirects keep working (next.config.ts).
  for (const [from, to] of [["/essentials", "/fragrance"], ["/jewelry", "/jewellery"], ["/essentials.html", "/fragrance"], ["/dresses.html", "/dresses"], ["/index.html", "/"]]) {
    const res = await get(from)
    assert.ok([301, 308].includes(res.status) && new URL(res.location, "http://x").pathname === to, `${from} redirects to ${to}`)
  }
  // The owner hides a collection: its page is gone, the rest are unaffected.
  await ctx.db.collection.update({ where: { handle: "fragrance" }, data: { hidden: true } })
  assert.equal((await get("/fragrance")).status, 404)
  assert.equal((await get("/ethnic-festive")).status, 200)
  await ctx.db.collection.update({ where: { handle: "fragrance" }, data: { hidden: false } })
  assert.equal((await get("/fragrance")).status, 200)
})

test("CHV-S10-M08 when the API is down each collection page says so calmly and shows no sample products", async () => {
  await ctx.teardown()
  apiClosed = true
  for (const [slug, page] of COPY) {
    const res = await get(`/${slug}`)
    assert.equal(res.status, 200, `${slug} still renders`)
    const text = decode(res.html)
    assert.ok(text.includes("The store is temporarily unavailable. Please try again in a few minutes."), slug)
    assert.ok(text.includes(page.heading[0]), `${slug} keeps its editorial copy`)
    assert.ok(!text.includes("Collection kurta") && !text.includes("Bulk piece"), `${slug} serves nothing stale`)
    noSamples(res.html)
  }
})
