// CHV-S11-M12 (Stage 11.12): the Stage 11 gate. The bag works on its own, end to end through the
// production web host: a guest shops, reloads, signs in (the guest bag merges), changes quantities and
// signs out; prices and availability are always the catalogue's current ones; an unreachable API is a
// clean error; no shopper ever sees another's bag or identity; nothing in the bag reserves stock; and
// checkout stays closed. Real HTTP against `next start` (`npm run build` first); the API runs
// in-process on a throwaway database with fixtures. Fixtures only: no real catalogue exists yet.
import { after, before, describe, test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { ROOT } from "../integration/database/helpers.mjs"
import { ORIGIN, setup } from "../security/auth/helpers.mjs"

const PORT = 5667
const WEB = `http://127.0.0.1:${PORT}`
let ctx, web, forward
let output = ""
const v = {}

let browsers = 0
/** A tiny browser on the shop: keeps cookies and sends what a same-origin fetch sends, from its own address. */
class Browser {
  cookies = new Map()
  // Each browser is a different visitor, as the hosting platform's x-forwarded-for would show (sign-in is rate limited per address).
  ip = `203.0.113.${(++browsers % 250) + 1}`
  async call(method, path, body, headers = {}) {
    // Sign-in is checked by Better Auth against the configured site address; cart routes against the host used.
    const origin = path.startsWith("/api/auth") ? ORIGIN : WEB
    const h = { accept: "application/json", "sec-fetch-site": "same-origin", origin, "x-forwarded-for": this.ip, ...headers }
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
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = text
    }
    return { status: res.status, json, text, headers: res.headers }
  }
  bag = async () => (await this.call("GET", "/api/cart")).json.data
  add = (variantId, quantity = 1) => this.call("POST", "/api/cart/lines", { variantId, quantity }, { "idempotency-key": randomUUID() })
  setQuantity = (lineId, quantity) => this.call("PATCH", `/api/cart/lines/${lineId}`, { quantity })
  async signIn(email) {
    assert.equal((await this.call("POST", "/api/auth/email-otp/send-verification-otp", { email, type: "sign-in" })).status, 200)
    const otp = ctx.otp.latestDevOtp(email, "sign-in")
    const res = await this.call("POST", "/api/auth/sign-in/email-otp", { email, otp })
    assert.equal(res.status, 200, `sign-in: ${res.status}`)
  }
  signOut = () => this.call("POST", "/api/auth/sign-out", {})
}
const quantities = bag => Object.fromEntries((bag?.lines ?? []).map(l => [l.variantId, l.quantity]))

async function variant(handle, { pricePaise = 120000n, onHand = 20 } = {}) {
  const created = await ctx.db.product.create({
    data: { handle, title: `Fixture ${handle}`, status: "active", publishedAt: new Date(), variants: { create: [{ sku: `${handle}-m`, title: "M", optionKey: "size:m", pricePaise }] } },
    include: { variants: true },
  })
  await ctx.db.inventoryBalance.create({ data: { variantId: created.variants[0].id, onHand, lastCountedAt: new Date() } })
  return { id: created.variants[0].id, productId: created.id }
}

/** Every stock number and every stock record, to prove the bag never touches them. */
const stockSnapshot = async () => ({
  balances: (await ctx.db.inventoryBalance.findMany({ orderBy: { variantId: "asc" } })).map(b => [b.variantId, b.onHand, b.reserved, b.allocated, b.version]),
  reservations: await ctx.db.inventoryReservation.count(),
  movements: await ctx.db.inventoryMovement.count(),
  orders: await ctx.db.order.count(),
})

before(async () => {
  assert.ok(existsSync(join(ROOT, ".next", "BUILD_ID")), "run `npm run build` before the page tests")
  ctx = await setup("chaanavya_test_s11_gate")
  ;({ forwardToApi: forward } = await import("@/lib/api/forward"))
  v.kurta = (await variant("fixture-gate-kurta", { pricePaise: 249900n })).id
  v.saree = (await variant("fixture-gate-saree", { pricePaise: 520000n, onHand: 3 })).id
  v.scarf = (await variant("fixture-gate-scarf", { pricePaise: 45000n })).id
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

describe("CHV-S11-M12 Stage 11 gate", () => {
  test("a guest shops, reloads, signs in, changes quantities and signs out: the bag follows every step, and no stock moves", async () => {
    const stock = await stockSnapshot()
    const browser = new Browser()
    await browser.add(v.kurta, 2)
    await browser.add(v.scarf, 1)
    const reloaded = new Browser()
    reloaded.cookies = new Map(browser.cookies)
    assert.deepEqual(quantities(await reloaded.bag()), { [v.kurta]: 2, [v.scarf]: 1 }, "survives a reload")

    // The same person already had an account bag on another device.
    const email = "gate.shopper@example.com"
    const phone = new Browser()
    await phone.signIn(email)
    await phone.add(v.kurta, 1)
    await phone.add(v.saree, 1)

    await browser.signIn(email)
    assert.equal(browser.cookies.has("chaanavya_guest"), false, "the guest cookie is retired at sign-in")
    const merged = await browser.bag()
    assert.deepEqual(quantities(merged), { [v.kurta]: 2, [v.saree]: 1, [v.scarf]: 1 }, "larger quantity kept, nothing doubled")
    assert.deepEqual(quantities(await phone.bag()), quantities(merged), "the other device sees the same bag")

    // Signing in again with the same (now dead) guest cookie merges nothing more.
    const replay = new Browser()
    replay.cookies = new Map(reloaded.cookies)
    await replay.signIn(email)
    assert.deepEqual(quantities(await replay.bag()), quantities(merged))

    const kurta = merged.lines.find(l => l.variantId === v.kurta)
    assert.equal((await browser.setQuantity(kurta.id, 4)).status, 200)
    assert.equal((await browser.setQuantity(kurta.id, 11)).status, 400, "an invalid quantity is refused")
    assert.equal((await browser.bag()).lines.find(l => l.id === kurta.id).quantity, 4)

    await browser.signOut()
    assert.equal(await browser.bag(), null, "after sign-out the browser has no bag")
    await browser.add(v.scarf)
    assert.deepEqual(quantities(await browser.bag()), { [v.scarf]: 1 }, "a new guest, with a new empty bag")
    assert.deepEqual(await stockSnapshot(), stock, "no balance, reservation, movement or order was created or changed")
  })

  test("prices and availability are always the catalogue's current ones", async () => {
    const item = await variant("fixture-gate-stale", { pricePaise: 100000n, onHand: 5 })
    const browser = new Browser()
    await browser.add(item.id, 3)
    await browser.add(v.scarf, 1)
    await ctx.db.productVariant.update({ where: { id: item.id }, data: { pricePaise: 130000n } })
    let bag = await browser.bag()
    assert.equal(bag.lines.find(l => l.variantId === item.id).unitPrice.amountPaise, 130000, "a price change shows at once")
    assert.equal(bag.subtotal.amountPaise, 3 * 130000 + 45000)

    // Other orders take the stock: the bag can be lowered, not raised.
    await ctx.db.inventoryBalance.update({ where: { variantId: item.id }, data: { reserved: 4 } })
    const line = bag.lines.find(l => l.variantId === item.id)
    assert.equal((await browser.setQuantity(line.id, 4)).status, 409)
    assert.equal((await browser.setQuantity(line.id, 1)).status, 200)

    // Taken off sale: flagged, left out of the subtotal, still removable.
    await ctx.db.product.update({ where: { id: item.productId }, data: { status: "archived" } })
    bag = await browser.bag()
    assert.deepEqual(bag.issues, [{ kind: "unavailable", lineId: line.id }])
    assert.equal(bag.subtotal.amountPaise, 45000)
    assert.equal((await browser.add(item.id)).status, 404, "it can no longer be added")
    assert.equal((await browser.call("DELETE", `/api/cart/lines/${line.id}`)).status, 200)
  })

  test("an unreachable API is a clean, uncached error for the bag, and nothing is half-done", async () => {
    const dead = { url: "http://127.0.0.1:9", key: ctx.api.key }
    for (const [method, path, body] of [["GET", "/api/cart"], ["POST", "/api/cart/lines", { variantId: v.kurta, quantity: 1 }], ["PATCH", `/api/cart/lines/${randomUUID()}`, { quantity: 2 }], ["DELETE", "/api/cart"]]) {
      const request = new Request(`${ORIGIN}${path}`, { method, headers: { "content-type": "application/json", origin: ORIGIN, "idempotency-key": randomUUID() }, body: body ? JSON.stringify(body) : undefined })
      const res = await forward(request, dead)
      assert.equal(res.status, 502, `${method} ${path}`)
      assert.deepEqual(await res.json(), { error: "api_unavailable" })
      assert.equal(res.headers.get("cache-control"), "no-store")
    }
    // The drawer turns any failure into a message and keeps showing what it had; it never invents a bag.
    const provider = readFileSync(join(ROOT, "components/cart/cart-provider.tsx"), "utf8")
    assert.match(provider, /Your bag could not be updated\. Please try again\./)
    assert.match(provider, /the API is unreachable; keep showing what we have/)
  })

  test("no shopper sees another's bag, account or session, on any cart route", async () => {
    const alice = new Browser()
    await alice.signIn("gate.alice@example.com")
    await alice.add(v.kurta, 2)
    const aliceBag = await alice.bag()
    const user = await ctx.db.user.findUniqueOrThrow({ where: { email: "gate.alice@example.com" } })
    const guest = new Browser()
    await guest.add(v.scarf)
    const guestToken = guest.cookies.get("chaanavya_guest")
    const guestCart = await ctx.db.cart.findUniqueOrThrow({ where: { id: (await guest.bag()).id } })

    const secrets = [user.id, "gate.alice@example.com", guestToken, guestCart.guestSessionId]
    const aliceLine = aliceBag.lines[0].id
    const intruder = new Browser()
    await intruder.add(v.saree)
    const responses = [
      await intruder.call("GET", "/api/cart"),
      await intruder.call("GET", `/api/cart/${aliceBag.id}`),
      await intruder.call("PATCH", `/api/cart/lines/${aliceLine}`, { quantity: 1 }),
      await intruder.call("DELETE", `/api/cart/lines/${aliceLine}`),
      await intruder.call("POST", "/api/cart/promotion", { code: "NOPE123" }),
      await alice.call("GET", "/api/cart"),
      await guest.call("GET", "/api/cart"),
    ]
    assert.equal(responses[1].status, 404)
    assert.equal(responses[2].status, 404)
    for (const res of responses) {
      for (const secret of secrets) assert.ok(!res.text.includes(secret), "no user id, email, guest token or guest session id in any response")
      assert.equal(res.headers.get("cache-control"), "no-store")
    }
    assert.deepEqual(quantities(await alice.bag()), { [v.kurta]: 2 }, "alice's bag untouched")
    // The audit trail of the earlier merge names the customer but holds no guest token.
    for (const e of await ctx.db.auditEvent.findMany({ where: { action: "cart.merged" } })) assert.ok(!JSON.stringify(e).includes(guestToken))
  })

  test("checkout stays closed: no checkout, payment, quote or webhook route, page or API, and the bag's checkout button is disabled", async () => {
    // Since Stage 12.11 /checkout is the order review page in development and staging (this server runs as
    // development); production answers 404 and the bag keeps its disabled button there
    // (tests/e2e/checkout-review.test.mjs). Payment and order routes stay closed everywhere.
    for (const path of ["/payment", "/api/checkout", "/api/payments", "/api/quotes", "/api/cart/checkout"]) {
      const res = await fetch(WEB + path, { method: path.startsWith("/api") ? "POST" : "GET", headers: { "content-type": "application/json", origin: WEB }, body: path.startsWith("/api") ? "{}" : undefined, redirect: "manual" })
      assert.ok([401, 404, 405].includes(res.status), `${path} answered ${res.status}`)
    }
    // Since Stage 14.09 Razorpay's webhook exists outside production; this test's API has no payment key, so
    // payments are off (503) and an unsigned call is never taken (tests/security/payments/webhook-signature.test.mjs).
    const webhook = await fetch(`${WEB}/api/webhooks/razorpay`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", redirect: "manual" })
    assert.equal(webhook.status, 503)
    const api = JSON.parse(readFileSync(join(ROOT, "packages/contracts/openapi/api.json"), "utf8"))
    // Stage 12.09 and 12.10 add the quote preview and its check, which price the bag and place no order, take no payment
    // and reserve nothing (tests/security/checkout/quote*.test.mjs). Every other such path stays closed.
    assert.deepEqual(Object.keys(api.paths).filter(p => /checkout|payment|webhook|quote/i.test(p) && p !== "/api/v1/cart/quote" && p !== "/api/v1/cart/quote/{quoteId}"), ["/api/v1/cart/order/{orderId}/payment", "/api/v1/cart/order/{orderId}/payment/return", "/api/v1/admin/payments/{attemptId}/refunds", "/api/v1/webhooks/razorpay"])
    assert.ok(Object.keys(api.paths).some(p => p.startsWith("/api/v1/cart")), "the cart API itself exists")
    const sheet = readFileSync(join(ROOT, "components/cart/cart-sheet.tsx"), "utf8")
    assert.match(sheet, /<Button[^>]*disabled[^>]*>\s*Checkout opens soon/s)
  })

  test("the bag never reserves stock, whatever is done to it", async () => {
    const stock = await stockSnapshot()
    const browser = new Browser()
    for (let i = 0; i < 3; i++) await browser.add(v.saree, 1)
    const bag = await browser.bag()
    await browser.setQuantity(bag.lines[0].id, 2)
    await browser.call("DELETE", `/api/cart/lines/${bag.lines[0].id}`)
    await browser.add(v.kurta, 5)
    await browser.call("DELETE", "/api/cart")
    assert.deepEqual(await stockSnapshot(), stock)
  })
})
