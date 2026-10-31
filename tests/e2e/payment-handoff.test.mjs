// CHV-S14-M06: raw card numbers never enter Chaanavya's servers. The pay page (app/(store)/checkout/pay,
// components/checkout/payment-handoff.tsx, lib/payment-handoff.ts) hands the pending order to Razorpay's
// Standard Checkout, which collects every payment detail in Razorpay's own frame on Razorpay's host. Proved
// four ways: the page and every component have no payment-detail field; the browser may load Razorpay's
// script and frame on the pay page only; Razorpay is handed public values only; and a request stuffed with a
// card number, CVV and expiry leaves no trace of them in the database, the API's output or the call to
// Razorpay. Real HTTP against `next start` (`npm run build` first), one server as development and one as
// production; the API runs in-process on a throwaway database with Razorpay as a recording stand-in on
// the network. Keys are fake; the card is Razorpay's published test card.
import { after, before, describe, test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { ROOT } from "../integration/database/helpers.mjs"
import { createStaff, setup } from "../security/auth/helpers.mjs"
import { isPayPath, RAZORPAY_CHECKOUT_HOSTS, RAZORPAY_CHECKOUT_SCRIPT, razorpayCheckoutOptions } from "../../lib/payment-handoff.ts"

const DEV = { port: 5681 }
const PROD = { port: 5682 }
const SANDBOX = { PAYMENT_MODE: "test", RAZORPAY_KEY_ID: "rzp_test_FAKE0000000016", RAZORPAY_KEY_SECRET: "fake-key-secret-14-06-0001", RAZORPAY_WEBHOOK_SECRET: "fake-webhook-secret-14-06-0001" }
const CARD = { number: "4111111111111111", spaced: "4111 1111 1111 1111", cvv: "927", expiry: "11/31" }
let ctx, variantId
let ip = 0
const url = server => `http://127.0.0.1:${server.port}`

// ---- Razorpay stand-in (orders API only; the checkout itself runs in the browser, on Razorpay) -----
const razorpay = { calls: [], orders: [] }
const realFetch = globalThis.fetch
globalThis.fetch = async (target, init) => {
  if (!String(target).startsWith("https://api.razorpay.com/")) return realFetch(target, init)
  razorpay.calls.push({ method: init.method, url: String(target), body: init.body ?? null })
  if (init.method === "GET") {
    const items = razorpay.orders.filter(o => o.receipt === new URL(target).searchParams.get("receipt"))
    return { status: 200, json: async () => ({ entity: "collection", count: items.length, items }) }
  }
  const body = JSON.parse(init.body)
  const order = { id: `order_Fake${razorpay.orders.length + 1}${randomUUID().slice(0, 6)}`, entity: "order", amount: body.amount, currency: body.currency, receipt: body.receipt, notes: body.notes, status: "created" }
  razorpay.orders.push(order)
  return { status: 200, json: async () => order }
}

/** A visitor on one web host: keeps cookies, sends what a same-origin fetch sends. */
class Browser {
  cookies = new Map()
  constructor(server = DEV) {
    this.web = url(server)
    this.ip = `198.51.100.${(ip = (ip % 250) + 1)}`
  }
  async call(method, path, body, headers = {}) {
    const h = { accept: "application/json", "sec-fetch-site": "same-origin", origin: this.web, "x-forwarded-for": this.ip, ...headers }
    if (body !== undefined) h["content-type"] = "application/json"
    if (this.cookies.size) h.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ")
    const res = await realFetch(this.web + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" })
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";")
      const [name, ...rest] = pair.trim().split("=")
      this.cookies.set(name, rest.join("="))
    }
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      /* a page */
    }
    return { status: res.status, json, text, headers: res.headers }
  }
  /** Bag, address, quote and order, as the review does; returns the pending order. */
  async placeOrder() {
    assert.equal((await this.call("POST", "/api/cart/lines", { variantId, quantity: 1 }, { "idempotency-key": randomUUID() })).status, 200)
    const address = { name: "Synthetic Buyer", phone: "+91 60000 00000", line1: "1 Example Road", line2: null, landmark: null, city: "Bengaluru", district: "Bengaluru Urban", stateCode: "IN-KA", pinCode: "560034" }
    assert.equal((await this.call("PUT", "/api/cart/contact", { email: "buyer@example.com", shippingAddress: address })).status, 200)
    const quote = (await this.call("POST", "/api/cart/quote", {})).json.data
    const placed = await this.call("POST", "/api/cart/order", { quoteId: quote.id, expectedGrandTotal: quote.grandTotal }, { "idempotency-key": randomUUID() })
    assert.equal(placed.status, 201, JSON.stringify(placed.json))
    return placed.json.data
  }
}

async function start(server, appEnv) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !["DATABASE_URL", "DIRECT_URL", "BETTER_AUTH_SECRET", "CATALOGUE_REVALIDATE_SECONDS", ...Object.keys(SANDBOX)].includes(name)))
  server.output = ""
  server.proc = spawn(process.execPath, [join(ROOT, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(server.port)], {
    cwd: ROOT,
    env: { ...env, NODE_ENV: "production", APP_ENV: appEnv, API_URL: ctx.api.url, API_INTERNAL_KEY: ctx.api.key },
  })
  server.proc.stdout.on("data", d => (server.output += d))
  server.proc.stderr.on("data", d => (server.output += d))
  for (let i = 0; i < 60; i++) {
    try {
      if ((await realFetch(`${url(server)}/robots.txt`)).status === 200) return
    } catch {
      /* not up yet */
    }
    await new Promise(r => setTimeout(r, 1000))
  }
  throw new Error(`next start (${appEnv}) did not come up:\n${server.output.slice(-1500)}`)
}

/** Every text-like value in every table, searched for the card's digits, CVV and expiry. */
async function databaseHolds(...needles) {
  const tables = await ctx.db.$queryRawUnsafe(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`)
  const found = []
  for (const { table_name: name } of tables) {
    for (const needle of needles) {
      const [{ n }] = await ctx.db.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "${name}" t WHERE row_to_json(t)::text LIKE $1`, `%${needle}%`)
      if (n > 0) found.push(`${name}: ${needle}`)
    }
  }
  return { tables: tables.length, found }
}

before(async () => {
  assert.ok(existsSync(join(ROOT, ".next", "BUILD_ID")), "run `npm run build` before the page tests")
  ctx = await setup("chaanavya_test_s14_payment_handoff")
  const { user } = await createStaff(ctx, "s14.handoff.owner@example.com", "OWNER")
  await ctx.db.taxProfile.create({ data: { sellerStateCode: "IN-KA", pricesIncludeTax: true, note: "synthetic test values", createdById: user.id, rates: { create: [{ taxCategory: "apparel_cotton", hsnCode: "6204", rateBasisPoints: 500 }] } } })
  const p = await ctx.db.product.create({
    data: { handle: "fixture-handoff", title: "Fixture hand-off", status: "active", publishedAt: new Date(), shippingRestriction: "none", variants: { create: [{ sku: "fixture-handoff-m", title: "M", optionKey: "size:m", pricePaise: 189900n, taxCategory: "apparel_cotton", weightGrams: 300 }] } },
    include: { variants: true },
  })
  variantId = p.variants[0].id
  await ctx.db.inventoryBalance.create({ data: { variantId, onHand: 20, lastCountedAt: new Date() } })
  Object.assign(process.env, SANDBOX)
  await Promise.all([start(DEV, "development"), start(PROD, "production")])
})
after(async () => {
  DEV.proc?.kill()
  PROD.proc?.kill()
  globalThis.fetch = realFetch
  for (const name of Object.keys(SANDBOX)) delete process.env[name]
  await ctx?.teardown()
})

const directive = (csp, name) => csp.split(";").map(d => d.trim()).find(d => d.split(" ")[0] === name) ?? null

describe("CHV-S14-M06 the browser may reach Razorpay on the pay page only", () => {
  test("the pay page lets Razorpay's script, frame and hosts in, nothing else, and keeps form posts on our own host", async () => {
    const page = await new Browser().call("GET", `/checkout/pay/${randomUUID()}`, undefined, { accept: "text/html" })
    assert.equal(page.status, 200)
    const csp = page.headers.get("content-security-policy")
    assert.equal(directive(csp, "frame-src"), `frame-src ${RAZORPAY_CHECKOUT_HOSTS.frame.join(" ")}`)
    for (const host of RAZORPAY_CHECKOUT_HOSTS.connect) assert.ok(directive(csp, "connect-src").includes(host))
    assert.ok(directive(csp, "script-src").includes("https://checkout.razorpay.com"))
    assert.equal(directive(csp, "form-action"), "form-action 'self'", "no form on our page can post anywhere else")
    assert.equal(directive(csp, "default-src"), "default-src 'self'")
    assert.equal((csp.match(/razorpay\.com/g) ?? []).length, Object.values(RAZORPAY_CHECKOUT_HOSTS).flat().length, "only the listed Razorpay hosts")
    assert.equal(page.headers.get("cross-origin-opener-policy"), "same-origin-allow-popups")
    assert.ok(!/<input|<form/i.test(page.text), "the page itself has no fields")
  })

  test("every other page keeps the strict policy: no Razorpay, no frames, same-origin opener", async () => {
    for (const path of ["/", "/checkout", `/checkout/pay/${randomUUID()}/extra`, "/checkout/pay/not-an-order"]) {
      const page = await new Browser().call("GET", path, undefined, { accept: "text/html" })
      const csp = page.headers.get("content-security-policy") ?? ""
      assert.ok(!csp.includes("razorpay"), path)
      assert.equal(directive(csp, "frame-src"), null, path)
      assert.equal(page.headers.get("cross-origin-opener-policy"), "same-origin", path)
    }
    assert.deepEqual([isPayPath(`/checkout/pay/${randomUUID()}`), isPayPath("/checkout/pay/x"), isPayPath("/admin/checkout/pay/x")], [true, false, false])
  })

  test("in production the pay page does not exist and Razorpay is allowed nowhere", async () => {
    const page = await new Browser(PROD).call("GET", `/checkout/pay/${randomUUID()}`, undefined, { accept: "text/html" })
    assert.equal(page.status, 404)
    assert.ok(!(page.headers.get("content-security-policy") ?? "").includes("razorpay"))
  })
})

describe("CHV-S14-M06 Razorpay is handed public values only", () => {
  const session = (over = {}, params = {}) => ({
    attemptId: randomUUID(),
    provider: "razorpay",
    providerOrderId: "order_Abc123",
    amount: { amountPaise: 199500, currency: "INR" },
    next: { kind: "embedded", publicParams: { key: "rzp_test_Abc", order_id: "order_Abc123", amount: "199500", currency: "INR", name: "Chaanavya", description: "Order CHV-1", ...params } },
    ...over,
  })

  test("only the key ID, Razorpay's order, the amount, the currency and the shop's own words are passed; anything else is dropped", () => {
    const options = razorpayCheckoutOptions(session({}, { prefill: "x", card: CARD.number, cvv: CARD.cvv, method: "card", callback_url: "https://evil.example" }))
    assert.deepEqual(Object.keys(options).sort(), ["amount", "currency", "description", "key", "name", "order_id"])
    assert.ok(!JSON.stringify(options).includes(CARD.number) && !JSON.stringify(options).includes("evil"))
  })

  test("a session that does not agree with itself, a live key, another provider or a redirect is not opened", () => {
    for (const bad of [
      session({}, { key: "rzp_live_Abc" }),
      session({}, { key: "rzp_test_Abc", order_id: "order_Other1" }),
      session({}, { amount: "100" }),
      session({}, { currency: "USD" }),
      session({ amount: { amountPaise: 199500, currency: "USD" } }),
      session({ provider: "phonepe" }),
      session({ next: { kind: "redirect", url: "https://checkout.razorpay.com/x" } }),
    ])
      assert.equal(razorpayCheckoutOptions(bad), null, JSON.stringify(bad))
    assert.equal(RAZORPAY_CHECKOUT_SCRIPT, "https://checkout.razorpay.com/v1/checkout.js")
  })
})

describe("CHV-S14-M06 card details sent to us are never kept", () => {
  test("the whole hand-off with a card stuffed into every part of the request: the checkout opens, and the card is nowhere", async () => {
    const shopper = new Browser()
    const order = await shopper.placeOrder()
    assert.equal((await shopper.call("GET", `/api/cart/order/${order.id}`)).status, 200)

    const output = []
    const writes = [process.stdout.write, process.stderr.write]
    process.stdout.write = (chunk, ...rest) => (output.push(String(chunk)), writes[0].call(process.stdout, chunk, ...rest))
    process.stderr.write = (chunk, ...rest) => (output.push(String(chunk)), writes[1].call(process.stderr, chunk, ...rest))
    let res
    try {
      res = await shopper.call(
        "POST",
        `/api/cart/order/${order.id}/payment?card=${CARD.number}&cvv=${CARD.cvv}`,
        { card: { number: CARD.number, cvv: CARD.cvv, expiry: CARD.expiry }, cardNumber: CARD.spaced, amount: 100 },
        { "idempotency-key": `card-${randomUUID()}`, "x-card-number": CARD.number },
      )
    } finally {
      ;[process.stdout.write, process.stderr.write] = writes
    }
    assert.equal(res.status, 200, JSON.stringify(res.json))
    const options = razorpayCheckoutOptions(res.json.data)
    assert.ok(options, "the page can open Razorpay's checkout")
    assert.deepEqual([options.amount, options.order_id, options.key], [order.grandTotal.amountPaise, res.json.data.providerOrderId, SANDBOX.RAZORPAY_KEY_ID])

    const needles = [CARD.number, CARD.spaced, CARD.expiry]
    assert.ok(!needles.some(n => res.text.includes(n)), "not echoed to the browser")
    assert.ok(!razorpay.calls.some(c => needles.some(n => `${c.url}${c.body}`.includes(n))), "not passed on to Razorpay either")
    assert.ok(!needles.some(n => output.join("").includes(n)) && !DEV.output.includes(CARD.number), "not in the API's or the web host's output")
    const { tables, found } = await databaseHolds(...needles)
    assert.ok(tables > 40, `searched ${tables} tables`)
    assert.deepEqual(found, [], "no table holds the card number, its spaced form or the expiry")
  })
})

describe("CHV-S14-M06 no Chaanavya page or component asks for payment details", () => {
  const sources = dir =>
    readdirSync(join(ROOT, dir)).flatMap(name => {
      const path = join(ROOT, dir, name)
      return statSync(path).isDirectory() ? sources(relative(ROOT, path)) : /\.(tsx?|mjs)$/.test(name) ? [path] : []
    })

  test("no field anywhere in the storefront or admin is a card, CVV or expiry field", () => {
    const fieldPattern = /autoComplete=["']cc-|name=["'](card|cc|cvv|cvc|expiry)|id=["'][^"']*(card-?number|cvv|cvc)/i
    const offenders = ["app", "components", "lib"].flatMap(sources).filter(path => fieldPattern.test(readFileSync(path, "utf8")))
    assert.deepEqual(offenders.map(p => relative(ROOT, p)), [])
  })

  test("the pay component has no form or input, sends the payment request without a body, and loads Razorpay from one place", () => {
    const component = readFileSync(join(ROOT, "components/checkout/payment-handoff.tsx"), "utf8")
    assert.ok(!/<input|<form|<textarea/.test(component))
    assert.match(component, /call<PaymentSessionV1>\(`\$\{orderId\}\/payment`, \{ method: "POST", headers: \{ "idempotency-key": key\.current \} \}\)/)
    const loaders = ["app", "components", "lib"].flatMap(sources).filter(path => readFileSync(path, "utf8").includes("checkout.razorpay.com"))
    assert.deepEqual(loaders.map(p => relative(ROOT, p).replaceAll("\\", "/")), ["lib/payment-handoff.ts"])
  })
})
