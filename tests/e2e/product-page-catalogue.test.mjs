// CHV-S10-M09 (Stage 10.09): the product page shows a published product from the NestJS API: the
// gallery, and the price and stock of the variant a shopper chose (or was linked to), never another's.
// Missing and hidden handles are a 404, handles keep one canonical spelling, and the placeholder
// catalogue is never used. Real HTTP against the production build (`npm run build` first): `next
// start` gets only the API's address and key; the API runs in-process on a throwaway database.
// Fixtures only: no real catalogue exists yet.
import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { ROOT } from "../integration/database/helpers.mjs"
import { setup, staffWithMfa } from "../security/auth/helpers.mjs"
import { catalogueApi, countStock, fullChecklist, mediaStoreReady, png, readyDraft, sizes, uploadPhoto } from "../security/catalogue/helpers.mjs"
import { fallbackProducts } from "../../lib/catalog.ts"

const PORT = 5663
let ctx, c, admin, owner, web, ethnic
let output = ""
let apiClosed = false
const made = {}

const get = async (path, options = {}) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { headers: { accept: "text/html" }, redirect: "manual", ...options })
  return { status: res.status, location: res.headers.get("location"), html: await res.text() }
}
const decode = html => html.replaceAll("&amp;", "&").replaceAll("&#x27;", "'").replaceAll("&quot;", '"')
// The product's own panel: from its heading to the "You may also like" section (or the footer).
const panel = html => {
  const text = decode(html)
  const start = text.indexOf("<h1")
  const related = text.indexOf("You may also like")
  return text.slice(start, related > 0 ? related : text.indexOf("<footer"))
}
const relatedPart = html => {
  const text = decode(html)
  const i = text.indexOf("You may also like")
  return i < 0 ? "" : text.slice(i, text.indexOf("<footer"))
}

async function publish(title, prefix, collectionIds, body, counts, { photos = 1 } = {}) {
  const created = (await c.create(admin.jar, readyDraft(collectionIds, { title }))).json.data
  const saved = (await c.variants(admin.jar, created.id, created.etag, body ?? sizes(prefix))).json.data
  let etag = created.etag
  for (let i = 0; i < photos; i++) {
    const photo = await uploadPhoto(c, admin.jar, created.id, png(600 + i * 20, 800), { altText: `${title} ${i === 0 ? "front" : "back"} view` })
    etag = (await c.approve(owner.jar, photo.completed.json.data.media.at(-1).id, photo.completed.json.data.etag)).json.data.etag
  }
  const live = (await c.status(owner.jar, created.id, "publish", etag, { reason: "product page fixture", checklist: fullChecklist })).json.data
  if (counts) await countStock(c, admin.jar, owner.jar, saved.variants.map((v, i) => ({ sku: v.sku, counted: counts[i] })))
  return { ...live, title, variants: Object.fromEntries(saved.variants.map(v => [v.sku.split("-").pop(), v])) }
}

before(async () => {
  assert.ok(existsSync(join(ROOT, ".next", "BUILD_ID")), "run `npm run build` before the page tests")
  await mediaStoreReady()
  ctx = await setup("chaanavya_test_s10_productpage")
  c = catalogueApi(ctx)
  admin = await staffWithMfa(ctx, "s10m09.admin@example.com", "ADMIN")
  owner = await staffWithMfa(ctx, "s10m09.owner@example.com", "OWNER")
  ethnic = (await ctx.db.collection.findUnique({ where: { handle: "ethnic-festive" } })).id
  const p = `PP${process.pid}`

  // One product, three sizes with different prices and stock: S 2,499 (3), M 2,699 reduced from 2,999 (2), L 2,899 (sold out).
  made.main = await publish(
    "Product page kurta",
    p,
    [ethnic],
    {
      options: [{ name: "Size", values: ["S", "M", "L"] }],
      variants: [
        { options: { Size: "S" }, sku: `${p}-S`, pricePaise: "249900", taxCategory: "apparel" },
        { options: { Size: "M" }, sku: `${p}-M`, pricePaise: "269900", compareAtPricePaise: "299900", taxCategory: "apparel" },
        { options: { Size: "L" }, sku: `${p}-L`, pricePaise: "289900", taxCategory: "apparel" },
      ],
    },
    [3, 2, 0],
    { photos: 2 },
  )
  made.other = await publish("Product page other kurta", `${p}O`, [ethnic], null, [1, 1])
  made.soldOut = await publish("Product page sold out kurta", `${p}X`, [ethnic], null, [0, 0])
  made.draft = (await c.create(admin.jar, readyDraft([ethnic], { title: "Product page draft saree" }))).json.data
  made.uncounted = await publish("Product page uncounted kurta", `${p}U`, [ethnic], null, null)
  made.forged = await publish("Product page forged kurta", `${p}F`, [ethnic], null, [2, 2])
  await ctx.db.product.update({ where: { id: made.forged.id }, data: { publishedAt: null } })

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

const page = (query = "") => get(`/products/${made.main.handle}${query}`)

test("CHV-S10-M09 a published product shows its details, both photos, its collection and related products", async () => {
  const res = await page()
  assert.equal(res.status, 200)
  const text = decode(res.html)
  const mine = panel(res.html)
  assert.match(mine, /Product page kurta/)
  assert.ok(text.includes("A handloom cotton kurta with a straight cut"), "the description from the API")
  assert.ok(text.includes("Product page kurta front view") && text.includes("Product page kurta back view"), "both approved photos are in the gallery")
  assert.ok(text.includes('href="/ethnic-festive"') && text.includes("Ethnic & Festive"), "breadcrumb names its collection")
  assert.ok(new RegExp(`rel="canonical" href="[^"]*/products/${made.main.handle}"`).test(text), "one canonical address")
  const related = relatedPart(res.html)
  assert.ok(related.includes(`/products/${made.other.handle}`), "another product of the collection is suggested")
  assert.ok(!related.includes(`/products/${made.main.handle}`), "never itself")
  for (const hidden of ["Product page draft saree", "Product page uncounted kurta", "Product page forged kurta"]) assert.ok(!related.includes(hidden), `${hidden} is not suggested`)
})

test("CHV-S10-M09 before a choice the price is the first buyable size's and the button asks for a size", async () => {
  const mine = panel((await page()).html)
  assert.ok(mine.includes("₹2,499"), "S, the first size that can be bought")
  assert.ok(!mine.includes("Was"), "no reduced price on S")
  assert.ok(mine.includes("Select size"))
  assert.ok(!mine.includes("₹2,699") && !mine.includes("₹2,899"), "no other size's price")
})

test("CHV-S10-M09 a linked size shows that size's own price, reduced price and stock", async () => {
  const { S, M, L } = made.main.variants
  const s = panel((await page(`?variant=${S.id}`)).html)
  assert.ok(s.includes("₹2,499") && s.includes("Add to bag") && !s.includes("Currently unavailable"))
  const m = panel((await page(`?variant=${M.id}`)).html)
  assert.ok(m.includes("₹2,699") && m.includes("₹2,999") && /Was/.test(m), "M's price and its reduced-from price")
  assert.ok(m.includes("Add to bag"))
  const l = panel((await page(`?variant=${L.id}`)).html)
  assert.ok(l.includes("₹2,899"), "the sold-out size still shows its own price")
  assert.ok(l.includes("Currently unavailable") && !l.includes("Add to bag"), "and says it cannot be bought")
})

test("CHV-S10-M09 a bad variant link is ignored and reveals nothing", async () => {
  const baseline = panel((await page()).html)
  const foreign = made.other.variants.S.id // another product's variant
  const hidden = made.uncounted.variants.S.id
  for (const q of ["?variant=M", "?variant=1%20OR%201%3D1", "?variant=", "?variant=01900000-0000-7000-8000-000000000000", `?variant=${foreign}`, `?variant=${hidden}`, "?variant=a&variant=b"]) {
    const res = await page(q)
    assert.equal(res.status, 200, q)
    assert.equal(panel(res.html), baseline, `${q} shows the default view`)
  }
})

test("CHV-S10-M09 a fully sold-out product is found, shows its price and cannot be added", async () => {
  const res = await get(`/products/${made.soldOut.handle}`)
  assert.equal(res.status, 200)
  const mine = panel(res.html)
  assert.ok(mine.includes("₹2,499") && mine.includes("Currently unavailable") && !mine.includes("Add to bag"))
})

test("CHV-S10-M09 handles keep one canonical spelling; hidden, missing and sample handles are a plain 404", async () => {
  const upper = await get(`/products/${made.main.handle.toUpperCase()}`)
  assert.ok([301, 308].includes(upper.status) && new URL(upper.location, "http://x").pathname === `/products/${made.main.handle}`, "an upper-case link goes to the lower-case address")
  for (const [kind, p] of [["draft", made.draft], ["uncounted", made.uncounted], ["forged", made.forged]]) {
    const res = await get(`/products/${p.handle}`)
    assert.equal(res.status, 404, kind)
    assert.ok(!res.html.includes("Product page draft") && !res.html.includes("Product page uncounted") && !res.html.includes("Product page forged"), `${kind} is not named`)
  }
  assert.equal((await get("/products/no-such-product")).status, 404)
  for (const p of fallbackProducts) assert.equal((await get(`/products/${p.handle}`)).status, 404, `sample ${p.handle} is not served`)
})

test("CHV-S10-M09 when the API is down the page says so, is not indexed and shows no sample or stale product", async () => {
  await ctx.teardown()
  apiClosed = true
  const res = await page()
  assert.equal(res.status, 200)
  const text = decode(res.html)
  assert.match(text, /This product is temporarily unavailable\. Please try again in a few minutes\./)
  assert.match(text, /<meta name="robots" content="noindex/)
  assert.ok(!text.includes("Product page kurta") && !text.includes("₹2,499"))
  for (const p of fallbackProducts) assert.ok(!res.html.includes(`/products/${p.handle}`), `sample ${p.handle} is absent`)
})
