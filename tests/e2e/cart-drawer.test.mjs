// CHV-S11-M11 (Stage 11.11): the bag drawer works through the shop's own cart API, with no Shopify.
// Real HTTP against the production build (`npm run build` first): `next start` gets only the API's
// address and key; the API runs in-process on a throwaway database with a fixture product. Every
// call below is one the bag drawer makes (components/cart/cart-provider.tsx), sent to the web host
// exactly as the browser sends it, so the Next.js route handler and forwarder are exercised too.
import { after, before, describe, test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { ROOT } from "../integration/database/helpers.mjs"
import { setup } from "../security/auth/helpers.mjs"

const PORT = 5666
const WEB = `http://127.0.0.1:${PORT}`
let ctx, web
let output = ""
const v = {}

/** A tiny browser: keeps cookies and sends what a same-origin fetch from the shop sends. */
class Browser {
  cookies = new Map()
  async call(method, path, body, headers = {}) {
    const h = { accept: "application/json", "sec-fetch-site": "same-origin", origin: WEB, ...headers }
    if (body !== undefined) h["content-type"] = "application/json"
    if (this.cookies.size) h.cookie = [...this.cookies].map(([k, val]) => `${k}=${val}`).join("; ")
    const res = await fetch(WEB + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" })
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(";")
      const [name, ...rest] = pair.trim().split("=")
      if (attrs.some(a => /max-age=0/i.test(a)) || rest.join("=") === "") this.cookies.delete(name)
      else this.cookies.set(name, rest.join("="))
    }
    const text = await res.text()
    return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers }
  }
  bag = () => this.call("GET", "/api/cart")
  add = (variantId, quantity = 1) => this.call("POST", "/api/cart/lines", { variantId, quantity }, { "idempotency-key": randomUUID() })
  setQuantity = (lineId, quantity) => this.call("PATCH", `/api/cart/lines/${encodeURIComponent(lineId)}`, { quantity })
  remove = lineId => this.call("DELETE", `/api/cart/lines/${encodeURIComponent(lineId)}`)
  clear = () => this.call("DELETE", "/api/cart")
  applyCode = code => this.call("POST", "/api/cart/promotion", { code })
  removeCode = () => this.call("DELETE", "/api/cart/promotion")
}

async function variant(handle, pricePaise) {
  const created = await ctx.db.product.create({
    data: { handle, title: `Fixture ${handle}`, status: "active", publishedAt: new Date(), variants: { create: [{ sku: `${handle}-m`, title: "M", optionKey: "size:m", pricePaise }] } },
    include: { variants: true },
  })
  await ctx.db.inventoryBalance.create({ data: { variantId: created.variants[0].id, onHand: 20, lastCountedAt: new Date() } })
  return created.variants[0].id
}

before(async () => {
  assert.ok(existsSync(join(ROOT, ".next", "BUILD_ID")), "run `npm run build` before the page tests")
  ctx = await setup("chaanavya_test_s11_cart_drawer")
  v.shirt = await variant("fixture-drawer-shirt", 150000n)
  v.scarf = await variant("fixture-drawer-scarf", 50000n)
  await ctx.db.promotion.create({ data: { code: "DRAWER10", kind: "percent", percentBasisPoints: 1000, startsAt: new Date(Date.now() - 86_400_000), active: true } })
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !["DATABASE_URL", "DIRECT_URL", "BETTER_AUTH_SECRET", "CATALOGUE_REVALIDATE_SECONDS"].includes(name)))
  web = spawn(process.execPath, [join(ROOT, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)], {
    cwd: ROOT,
    env: { ...env, NODE_ENV: "production", APP_ENV: "development", API_URL: ctx.api.url, API_INTERNAL_KEY: ctx.api.key },
  })
  web.stdout.on("data", d => (output += d))
  web.stderr.on("data", d => (output += d))
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${WEB}/robots.txt`)).status === 200) return
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

describe("CHV-S11-M11 bag drawer on the shop's own cart API", () => {
  test("add, change, remove and clear work through the web host, with totals from the API", async () => {
    const browser = new Browser()
    assert.deepEqual((await browser.bag()).json, { data: null }, "an empty bag before the first add")

    const added = await browser.add(v.shirt)
    assert.equal(added.status, 200, JSON.stringify(added.json))
    assert.ok(browser.cookies.has("chaanavya_guest"), "the guest cookie reaches the browser through the web host")
    await browser.add(v.scarf, 2)
    let bag = (await browser.bag()).json.data
    assert.deepEqual(bag.lines.map(l => [l.variantId, l.quantity]), [[v.shirt, 1], [v.scarf, 2]])
    assert.equal(bag.subtotal.amountPaise, 150000 + 2 * 50000)

    const shirt = bag.lines[0]
    bag = (await browser.setQuantity(shirt.id, 3)).json.data
    assert.equal(bag.lines[0].quantity, 3)
    assert.equal(bag.subtotal.amountPaise, 3 * 150000 + 2 * 50000)

    bag = (await browser.applyCode("drawer10")).json.data
    assert.deepEqual(bag.promotion, { code: "DRAWER10", applied: true })
    assert.equal(bag.discount.amountPaise, Math.floor(bag.subtotal.amountPaise / 10))
    assert.equal(bag.total.amountPaise, bag.subtotal.amountPaise - bag.discount.amountPaise)
    assert.equal((await browser.applyCode("NOPE123")).json.error.fields.code, "not_found")
    bag = (await browser.removeCode()).json.data
    assert.equal(bag.promotion, null)

    bag = (await browser.remove(shirt.id)).json.data
    assert.deepEqual(bag.lines.map(l => l.variantId), [v.scarf])
    assert.equal((await browser.remove(shirt.id)).status, 200, "removing again is harmless")
    bag = (await browser.clear()).json.data
    assert.deepEqual(bag.lines, [])
    assert.equal(bag.subtotal.amountPaise, 0)
  })

  test("the bag survives a reload through the web host and is never cached", async () => {
    const browser = new Browser()
    await browser.add(v.scarf, 4)
    const again = new Browser()
    again.cookies = new Map(browser.cookies)
    const res = await again.bag()
    assert.equal(res.json.data.lines[0].quantity, 4)
    assert.equal(res.headers.get("cache-control"), "no-store")
  })

  test("errors from the API reach the drawer as the API sent them", async () => {
    const browser = new Browser()
    assert.equal((await browser.add(v.shirt, 11)).status, 400)
    assert.equal((await browser.call("POST", "/api/cart/lines", { variantId: v.shirt })).status, 428, "an add without a key")
    await browser.add(v.shirt, 1)
    const over = await browser.setQuantity((await browser.bag()).json.data.lines[0].id, 25)
    assert.equal(over.status, 400)
    const crossSite = await browser.call("POST", "/api/cart/lines", { variantId: v.scarf }, { "idempotency-key": randomUUID(), "sec-fetch-site": "cross-site", origin: "https://evil.example" })
    assert.equal(crossSite.status, 403)
    assert.equal((await browser.bag()).json.data.lines.length, 1)
  })

  test("the drawer calls only the shop's cart API, and the shop's code holds no Shopify cart or browser-only bag", () => {
    const provider = readFileSync(join(ROOT, "components/cart/cart-provider.tsx"), "utf8")
    assert.match(provider, /fetch\(`\/api\/cart\$\{path\}`/, "one fetch, to /api/cart")
    assert.equal([...provider.matchAll(/fetch\(/g)].length, 1, "no other request")
    for (const [method, path] of [["POST", "/lines"], ["PATCH", "path"], ["DELETE", "path"], ["POST", "/promotion"], ["DELETE", "/promotion"]]) {
      assert.ok(provider.includes(`"${method}"`) && provider.includes(path), `${method} ${path}`)
    }
    assert.match(provider, /"idempotency-key"/, "adds carry a key")
    assert.doesNotMatch(provider, /localStorage\.setItem|sessionStorage/, "the bag is not kept in the browser")
    const walk = dir => readdirSync(dir).flatMap(e => (statSync(join(dir, e)).isDirectory() ? walk(join(dir, e)) : [join(dir, e)]))
    const storefront = ["components/cart", "components/product", "app/(store)", "lib/api"].flatMap(d => walk(join(ROOT, d))).filter(f => /\.(ts|tsx)$/.test(f))
    for (const file of storefront) {
      const text = readFileSync(file, "utf8")
      assert.doesNotMatch(text, /myshopify|cdn\.shopify|storefront[-_ ]?access|cartCreate|cartLinesAdd|checkoutUrl|graphql\.json/i, file)
    }
    // The built browser code holds no Shopify endpoint either.
    const chunks = walk(join(ROOT, ".next", "static")).filter(f => f.endsWith(".js"))
    assert.ok(chunks.length > 0)
    for (const file of chunks) assert.doesNotMatch(readFileSync(file, "utf8"), /myshopify\.com|cdn\.shopify\.com|\/api\/20\d\d-\d\d\/graphql\.json/, file)
  })

  test("adding to the bag reserves no stock", async () => {
    const before = await ctx.db.inventoryBalance.findUniqueOrThrow({ where: { variantId: v.shirt } })
    const browser = new Browser()
    await browser.add(v.shirt, 5)
    const afterAdd = await ctx.db.inventoryBalance.findUniqueOrThrow({ where: { variantId: v.shirt } })
    assert.deepEqual([afterAdd.onHand, afterAdd.reserved, afterAdd.allocated], [before.onHand, before.reserved, before.allocated])
    assert.equal(await ctx.db.inventoryReservation.count(), 0)
  })
})
