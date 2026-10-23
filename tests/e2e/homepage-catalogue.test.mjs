// CHV-S10-M07 (Stage 10.07): the homepage shows approved, published products from the NestJS API and
// never the placeholder catalogue. Real HTTP against the production build (`npm run build` first):
// `next start` gets only the API's address and key (no database settings), and the API runs
// in-process on a throwaway database with fixtures. Fixtures only: no real catalogue exists yet.
import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { ROOT } from "../integration/database/helpers.mjs"
import { setup, staffWithMfa } from "../security/auth/helpers.mjs"
import { catalogueApi, countStock, fullChecklist, mediaStoreReady, png, readyDraft, sizes, uploadPhoto } from "../security/catalogue/helpers.mjs"
import { fallbackProducts } from "../../lib/catalog.ts"

const PORT = 5660
let ctx, c, admin, owner, ethnic, web
let output = ""
let apiClosed = false
const live = []

const home = async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/`, { headers: { accept: "text/html" } })
  return { status: res.status, html: await res.text() }
}
// The "New this week" section only, so editorial copy elsewhere on the page cannot match.
const newThisWeek = html => html.slice(html.indexOf('id="new"'), html.indexOf("Silhouettes for every hour"))
const decode = html => html.replaceAll("&amp;", "&").replaceAll("&#x27;", "'").replaceAll("&quot;", '"')

async function published(title, prefix, { count = true } = {}) {
  const created = (await c.create(admin.jar, readyDraft([ethnic], { title }))).json.data
  const saved = (await c.variants(admin.jar, created.id, created.etag, sizes(prefix))).json.data
  const photo = await uploadPhoto(c, admin.jar, created.id, png(600, 800), { altText: `${title} front view` })
  const approved = (await c.approve(owner.jar, photo.completed.json.data.media.at(-1).id, photo.completed.json.data.etag)).json.data
  const result = (await c.status(owner.jar, created.id, "publish", approved.etag, { reason: "homepage fixture", checklist: fullChecklist })).json.data
  if (count) await countStock(c, admin.jar, owner.jar, saved.variants.map((v, i) => ({ sku: v.sku, counted: i === 0 ? 4 : 0 })))
  return result
}

before(async () => {
  assert.ok(existsSync(join(ROOT, ".next", "BUILD_ID")), "run `npm run build` before the page tests")
  await mediaStoreReady()
  ctx = await setup("chaanavya_test_s10_homepage")
  c = catalogueApi(ctx)
  admin = await staffWithMfa(ctx, "s10m07.admin@example.com", "ADMIN")
  owner = await staffWithMfa(ctx, "s10m07.owner@example.com", "OWNER")
  ethnic = (await ctx.db.collection.findUnique({ where: { handle: "ethnic-festive" } })).id

  // The web host gets the API's address and key and nothing about the database.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !["DATABASE_URL", "DIRECT_URL", "BETTER_AUTH_SECRET"].includes(name)))
  web = spawn(process.execPath, [join(ROOT, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)], {
    cwd: ROOT,
    env: { ...env, NODE_ENV: "production", APP_ENV: "development", API_URL: ctx.api.url, API_INTERNAL_KEY: ctx.api.key, CATALOGUE_REVALIDATE_SECONDS: "0" },
  })
  web.stdout.on("data", d => (output += d))
  web.stderr.on("data", d => (output += d))
  for (let i = 0; i < 60; i++) {
    try {
      if ((await home()).status === 200) return
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

test("CHV-S10-M07 with nothing published the homepage keeps its editorial layout and shows no sample products", async () => {
  const { status, html } = await home()
  assert.equal(status, 200)
  const text = decode(html)
  for (const copy of ["Wear the", "crown.", "New this week", "Dresses & gowns.", "Heritage Sarees", "Shop by mood"]) assert.ok(text.includes(copy), `editorial copy kept: ${copy}`)
  assert.match(newThisWeek(text), /New arrivals will appear here soon\./)
  assert.ok(!newThisWeek(text).includes("/products/"), "no product card, no sample product")
  for (const p of fallbackProducts) assert.ok(!html.includes(`/products/${p.handle}`), `sample product ${p.handle} is nowhere on the page, search data included`)
  assert.ok(!/temporarily unavailable/.test(text), "an empty shop is not an outage")
})

test("CHV-S10-M07 published, counted products render from the API, newest first, capped at four, without hidden ones", async () => {
  for (let i = 1; i <= 5; i++) live.push(await published(`Homepage kurta ${i}`, `H${process.pid}${i}`))
  const draft = (await c.create(admin.jar, readyDraft([ethnic], { title: "Homepage draft saree" }))).json.data
  const uncounted = await published("Homepage uncounted kurta", `H${process.pid}U`, { count: false })

  const { status, html } = await home()
  assert.equal(status, 200)
  const section = decode(newThisWeek(html))
  const titles = [...section.matchAll(/Homepage kurta (\d)/g)].map(m => Number(m[1]))
  assert.deepEqual([...new Set(titles)], [5, 4, 3, 2], "the four newest, newest first; the oldest is left out")
  assert.ok(!section.includes("Homepage kurta 1"))
  for (const p of live.slice(1)) assert.ok(section.includes(`/products/${p.handle}`), `link to ${p.handle}`)
  assert.ok(section.includes("₹2,499"), "the API's price, formatted as rupees")
  assert.ok(section.includes("/_next/image?url=") && section.includes("127.0.0.1%3A9090"), "photos come from the photo store")
  assert.ok(!/New arrivals will appear here soon\./.test(section))
  // Hidden products and sample products are nowhere on the page, including the search data.
  for (const hidden of ["Homepage draft saree", "Homepage uncounted kurta", draft.handle, uncounted.handle]) assert.ok(!decode(html).includes(hidden), `${hidden} is absent`)
  for (const p of fallbackProducts) assert.ok(!html.includes(`/products/${p.handle}`), `sample product ${p.handle} is absent`)
  // The header search is built from the same published products.
  assert.ok(decode(html).includes("Homepage kurta 5"), "search data holds published products")
})

test("CHV-S10-M07 when the API is down the homepage says so calmly and still shows no sample products", async () => {
  await ctx.teardown()
  apiClosed = true
  const { status, html } = await home()
  assert.equal(status, 200, "the page still renders")
  const text = decode(html)
  assert.match(newThisWeek(text), /The store is temporarily unavailable\. Please try again in a few minutes\./)
  assert.ok(text.includes("Wear the") && text.includes("Shop by mood"), "editorial layout kept")
  assert.ok(!text.includes("Homepage kurta"), "nothing stale is served")
  for (const p of fallbackProducts) assert.ok(!html.includes(`/products/${p.handle}`), `sample product ${p.handle} is absent`)
})
