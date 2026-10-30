// CHV-S12-M13 (Stage 12.13): the Stage 12 gate. Price, address, delivery and tax edge cases run
// together, end to end through the production web host exactly as the checkout review calls it:
// every case either gets the correct quote or is blocked with an explanation, and payment stays
// disabled. Real HTTP against `next start` (`npm run build` first), one server as development and one
// as production; the API runs in-process on a throwaway database. Expected totals come from an
// independent working of the owner's rules (per line, nearest paisa, half up; CGST and SGST each at
// half the rate; discount and delivery fee shared by value), not from the server's code. Fixtures
// and tax values are synthetic; delivery is the sandbox courier (PINs ending 999 unserviceable, 998
// an outage) or a fake.
import { after, before, describe, test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { ROOT } from "../integration/database/helpers.mjs"
import { apiModule, createStaff, setup, signInCustomer } from "../security/auth/helpers.mjs"
import { canProceed, deliveryIssue, reviewSummary } from "../../lib/checkout.ts"
import { formatMoney } from "../../lib/types.ts"

const DEV = { port: 5671 }
const PROD = { port: 5672 }
let ctx, quotes
const v = {}
let ip = 0

const url = server => `http://127.0.0.1:${server.port}`

/** A visitor on one web host: keeps cookies, sends what a same-origin fetch sends, from its own address. */
class Browser {
  cookies = new Map()
  constructor(server = DEV) {
    this.web = url(server)
    this.ip = `198.51.100.${(ip = (ip % 250) + 1)}`
  }
  async call(method, path, body, headers = {}) {
    const h = { accept: "application/json", "sec-fetch-site": "same-origin", origin: this.web, "x-forwarded-for": this.ip, ...headers }
    if (body !== undefined) h["content-type"] = "application/json"
    if (this.cookies.size) h.cookie = [...this.cookies].map(([k, val]) => `${k}=${val}`).join("; ")
    const res = await fetch(this.web + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" })
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(";")
      const [name, ...rest] = pair.trim().split("=")
      if (attrs.some(a => /max-age=0/i.test(a)) || rest.join("=") === "") this.cookies.delete(name)
      else this.cookies.set(name, rest.join("="))
    }
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      /* a page */
    }
    return { status: res.status, json, text }
  }
  add = (key, quantity = 1) => this.call("POST", "/api/cart/lines", { variantId: v[key].id, quantity }, { "idempotency-key": randomUUID() })
  /** A guest gives an email; a signed-in customer's order emails go to the account email, so none is sent. */
  customer = false
  contact = (pinCode, stateCode) => this.call("PUT", "/api/cart/contact", { ...(this.customer ? {} : { email: "guest@example.com" }), shippingAddress: address(pinCode, stateCode) })
  rates = () => this.call("GET", "/api/cart/shipping-rates")
  quote = (body = {}) => this.call("POST", "/api/cart/quote", body)
  /** The review page's calls in its order. Returns what the shopper would see. */
  async review({ items, pinCode = "560034", stateCode = "IN-KA", code, serviceRef = null, body = {} }) {
    for (const [key, quantity] of items) assert.equal((await this.add(key, quantity)).status, 200, `add ${key}`)
    if (code) assert.equal((await this.call("POST", "/api/cart/promotion", { code })).status, 200)
    const saved = await this.contact(pinCode, stateCode)
    if (saved.status !== 200) return { contactRefused: saved }
    const rates = (await this.rates()).json?.data ?? null
    const quote = await this.quote({ ...body, serviceRef })
    const error = quote.status === 200 ? null : quote.json.error
    const issue = deliveryIssue(rates, error)
    return { rates, quote, error, issue, proceed: canProceed(quote.status === 200 ? quote.json.data : null, issue) }
  }
}

const address = (pinCode, stateCode) => ({ name: "Synthetic Guest", phone: "+91 60000 00000", line1: "1 Example Road", line2: null, landmark: null, city: "Example City", district: "Example District", stateCode, pinCode })

// ---- Independent working of the owner's rules (bigint paise) ----
const halfUp = (n, d) => (2n * n + d) / (2n * d)
function share(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0n)
  if (total === 0n || sum === 0n) return weights.map(() => 0n)
  const parts = weights.map(w => (total * w) / sum)
  let left = total - parts.reduce((a, b) => a + b, 0n)
  const order = weights.map((w, i) => [i, (total * w) % sum]).sort((a, b) => (a[1] === b[1] ? a[0] - b[0] : a[1] > b[1] ? -1 : 1))
  for (const [i] of order) if (left-- > 0n) parts[i] += 1n
  return parts
}
const gst = (value, rate, inclusive, intra) => {
  const r = BigInt(rate)
  if (!intra) return [inclusive ? halfUp(value * r, 10000n + r) : halfUp(value * r, 10000n)]
  const h = inclusive ? halfUp(value * r, 2n * (10000n + r)) : halfUp(value * r, 20000n)
  return [h, h]
}
/** lines: [{ price, quantity, rate }]; percent discount in basis points, rounded down; fee in paise. */
function expected({ lines, discountBp = 0, fee, intra, inclusive = true }) {
  const gross = lines.map(l => BigInt(l.price) * BigInt(l.quantity))
  const subtotal = gross.reduce((a, b) => a + b, 0n)
  const discount = (subtotal * BigInt(discountBp)) / 10000n
  const discounts = share(discount, gross)
  const values = gross.map((g, i) => g - discounts[i])
  const lineTax = values.map((val, i) => gst(val, lines[i].rate, inclusive, intra))
  const fees = share(BigInt(fee), values)
  const feeTax = fees.map((f, i) => gst(f, lines[i].rate, inclusive, intra))
  const sum = list => list.flat().reduce((a, b) => a + b, 0n)
  const tax = sum(lineTax) + sum(feeTax)
  const grand = subtotal - discount + BigInt(fee) + (inclusive ? 0n : tax)
  return { subtotal: Number(subtotal), discount: Number(discount), tax: Number(tax), grand: Number(grand), lineTax: lineTax.map(t => t.map(Number)), feeTax: feeTax.map(t => t.map(Number)) }
}
/** The courier's price for the sandbox (12.08): zone base plus a fixed amount per extra 500 g. */
const sandboxFee = (grams, zone, mode = "surface") => {
  const base = { surface: { local: 3000, regional: 4500, national: 6000 }, air: { local: 5000, regional: 7000, national: 9000 } }[mode][zone]
  return base + { surface: 2000, air: 4000 }[mode] * (Math.max(1, Math.ceil(grams / 500)) - 1)
}

/** A produced quote is correct: totals, each line's GST, the fee's GST, and what the shopper is shown. */
function assertQuote(q, want) {
  assert.deepEqual(
    [q.subtotal.amountPaise, q.discountTotal.amountPaise, q.taxTotal.amountPaise, q.grandTotal.amountPaise],
    [want.subtotal, want.discount, want.tax, want.grand],
  )
  assert.deepEqual(q.lines.map(l => l.tax.map(t => t.amount.amountPaise)), want.lineTax)
  const feeTax = want.feeTax.reduce((acc, parts) => acc + parts.reduce((a, b) => a + b, 0), 0)
  assert.equal(q.shipping.tax.reduce((a, t) => a + t.amount.amountPaise, 0), feeTax)
  assert.equal(reviewSummary(q).total, formatMoney(want.grand / 100), "the shopper is shown the API's total")
}

/** A blocked case explains itself: a reason in the API error and, for delivery, an issue with an action. */
function assertBlocked(result, { status = 409, field, value, issue }) {
  const res = result.contactRefused ?? result.quote
  assert.equal(res.status, status, JSON.stringify(res.json))
  assert.ok(res.json.error.message.length > 0, "an explanation")
  if (field) assert.equal(res.json.error.fields[field], value, JSON.stringify(res.json.error.fields))
  if (issue) {
    assert.equal(result.issue.kind, issue)
    assert.ok(result.issue.title && result.issue.detail && result.issue.actions.length > 0)
  }
  if (result.proceed !== undefined) assert.equal(result.proceed, false, "checkout cannot go on")
}

async function variant(key, { price, rate = "apparel_cotton", weightGrams = 400, restriction = "none", onHand = 50 }) {
  const p = await ctx.db.product.create({
    data: { handle: `fixture-gate-${key}`, title: `Fixture ${key}`, status: "active", publishedAt: new Date(), shippingRestriction: restriction, variants: { create: [{ sku: `fixture-gate-${key}`, title: "M", optionKey: "size:m", pricePaise: BigInt(price), taxCategory: rate, weightGrams }] } },
    include: { variants: true },
  })
  v[key] = { id: p.variants[0].id, price }
  await ctx.db.inventoryBalance.create({ data: { variantId: v[key].id, onHand, lastCountedAt: new Date() } })
}

async function start(server, appEnv) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !["DATABASE_URL", "DIRECT_URL", "BETTER_AUTH_SECRET", "CATALOGUE_REVALIDATE_SECONDS"].includes(name)))
  server.output = ""
  server.proc = spawn(process.execPath, [join(ROOT, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(server.port)], {
    cwd: ROOT,
    env: { ...env, NODE_ENV: "production", APP_ENV: appEnv, API_URL: ctx.api.url, API_INTERNAL_KEY: ctx.api.key },
  })
  server.proc.stdout.on("data", d => (server.output += d))
  server.proc.stderr.on("data", d => (server.output += d))
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${url(server)}/robots.txt`)).status === 200) return
    } catch {
      /* not up yet */
    }
    await new Promise(r => setTimeout(r, 1000))
  }
  throw new Error(`next start (${appEnv}) did not come up:\n${server.output.slice(-1500)}`)
}

before(async () => {
  assert.ok(existsSync(join(ROOT, ".next", "BUILD_ID")), "run `npm run build` before the page tests")
  ctx = await setup("chaanavya_test_s12_checkout_gate")
  quotes = await apiModule("checkout/quote")
  const { user } = await createStaff(ctx, "s12.gate.owner@example.com", "OWNER")
  await ctx.db.taxProfile.create({
    data: { sellerStateCode: "IN-KA", pricesIncludeTax: true, note: "synthetic test values", createdById: user.id, rates: { create: [{ taxCategory: "apparel_cotton", hsnCode: "6204", rateBasisPoints: 500 }, { taxCategory: "apparel_silk", hsnCode: "5007", rateBasisPoints: 1200 }] } },
  })
  await variant("kurta", { price: 189900 })
  await variant("saree", { price: 520000, rate: "apparel_silk", weightGrams: 600 })
  await variant("odd", { price: 99999, weightGrams: 250 })
  await variant("ring", { price: 1299900, weightGrams: 50, restriction: "jewellery_high_value" })
  await variant("oud", { price: 249900, weightGrams: 350, restriction: "fragrance_liquid" })
  await variant("unweighed", { price: 99900, weightGrams: null })
  await variant("heavy", { price: 99900, weightGrams: 25000 })
  await variant("scarce", { price: 99900, onHand: 1 })
  await variant("wool", { price: 99900, rate: "apparel_wool" })
  await ctx.db.promotion.create({ data: { code: "GATE10", kind: "percent", percentBasisPoints: 1000, startsAt: new Date(Date.now() - 86_400_000), active: true } })
  await Promise.all([start(DEV, "development"), start(PROD, "production")])
})
after(async () => {
  DEV.proc?.kill()
  PROD.proc?.kill()
  await ctx?.teardown()
})

describe("CHV-S12-M13 the correct quote is produced", () => {
  test("within Karnataka: CGST and SGST on goods and fee, cheapest delivery, prices including GST", async () => {
    const r = await new Browser().review({ items: [["kurta", 1]] })
    assert.equal(r.quote.status, 200, JSON.stringify(r.error))
    const q = r.quote.json.data
    assert.equal(q.shipping.serviceRef, "sandbox:surface")
    assertQuote(q, expected({ lines: [{ price: 189900, quantity: 1, rate: 500 }], fee: sandboxFee(400, "local"), intra: true }))
    assert.deepEqual(q.lines[0].tax.map(t => t.component), ["CGST", "SGST"])
    assert.deepEqual([r.issue, r.proceed, q.mode], [null, true, "test"])
  })

  test("to Maharashtra with a 10% code and two units: IGST, the discount and fee shared, the air option the shopper picked", async () => {
    const r = await new Browser().review({ items: [["kurta", 2]], pinCode: "400001", stateCode: "IN-MH", code: "GATE10", serviceRef: "sandbox:air" })
    const q = r.quote.json.data
    assertQuote(q, expected({ lines: [{ price: 189900, quantity: 2, rate: 500 }], discountBp: 1000, fee: sandboxFee(800, "national", "air"), intra: false }))
    assert.deepEqual(q.lines[0].tax.map(t => t.component), ["IGST"])
    assert.equal(q.shipping.serviceRef, "sandbox:air")
  })

  test("a mixed bag (5% and 12%) with an odd price: the fee's GST split by value, every paisa accounted for", async () => {
    const r = await new Browser().review({ items: [["kurta", 1], ["saree", 1], ["odd", 3]], code: "GATE10" })
    const q = r.quote.json.data
    assertQuote(
      q,
      expected({ lines: [{ price: 189900, quantity: 1, rate: 500 }, { price: 520000, quantity: 1, rate: 1200 }, { price: 99999, quantity: 3, rate: 500 }], discountBp: 1000, fee: sandboxFee(400 + 600 + 750, "local"), intra: true }),
    )
    assert.equal(q.lines.reduce((a, l) => a + l.discount.amountPaise, 0), q.discountTotal.amountPaise)
  })

  test("a replaced state code (Orissa) is stored as Odisha and priced as inter-state, national zone", async () => {
    const browser = new Browser()
    const r = await browser.review({ items: [["kurta", 1]], pinCode: "751001", stateCode: "IN-OR" })
    assert.equal((await browser.call("GET", "/api/cart/contact")).json.data.shippingAddress.stateCode, "IN-OD")
    assertQuote(r.quote.json.data, expected({ lines: [{ price: 189900, quantity: 1, rate: 500 }], fee: sandboxFee(400, "national"), intra: false }))
  })

  test("perfume is quoted by surface only", async () => {
    const r = await new Browser().review({ items: [["oud", 1]] })
    assert.deepEqual(r.rates.quote.options.map(o => o.serviceRef), ["sandbox:surface"])
    assertQuote(r.quote.json.data, expected({ lines: [{ price: 249900, quantity: 1, rate: 500 }], fee: sandboxFee(350, "local"), intra: true }))
  })

  test("a signed-in customer gets the same quote, with the account's email", async () => {
    const browser = new Browser()
    const email = `s12.gate.${randomUUID().slice(0, 8)}@example.com`
    const jar = await signInCustomer(ctx, email)
    browser.cookies = new Map(jar.cookies)
    browser.customer = true
    const r = await browser.review({ items: [["kurta", 1]] })
    assert.equal(r.quote.status, 200, JSON.stringify(r.error))
    assert.equal((await browser.call("GET", "/api/cart/contact")).json.data.email, email)
    assertQuote(r.quote.json.data, expected({ lines: [{ price: 189900, quantity: 1, rate: 500 }], fee: sandboxFee(400, "local"), intra: true }))
  })

  test("tampered prices, totals and fees in the request change nothing", async () => {
    const browser = new Browser()
    const honest = await browser.review({ items: [["kurta", 1]] })
    const tampered = await browser.quote({ grandTotal: { amountPaise: 1, currency: "INR" }, unitPricePaise: 1, shippingFee: { amountPaise: 0, currency: "INR" }, discountPaise: 999999, taxTotal: { amountPaise: 0, currency: "INR" }, pricesIncludeTax: false })
    assert.equal(tampered.status, 200)
    assert.equal(tampered.json.data.grandTotal.amountPaise, honest.quote.json.data.grandTotal.amountPaise)
  })
})

describe("CHV-S12-M13 checkout blocks with an explanation", () => {
  test("address: a malformed PIN, an unknown state, a non-mobile phone, or no address at all", async () => {
    assertBlocked(await new Browser().review({ items: [["kurta", 1]], pinCode: "056001" }), { status: 400, field: "shippingAddress.pinCode", value: "invalid" })
    assertBlocked(await new Browser().review({ items: [["kurta", 1]], stateCode: "IN-ZZ" }), { status: 400, field: "shippingAddress.stateCode", value: "invalid" })
    const phone = new Browser()
    await phone.add("kurta")
    const badPhone = await phone.call("PUT", "/api/cart/contact", { email: "guest@example.com", shippingAddress: { ...address("560034", "IN-KA"), phone: "+91 22 2222 3333" } })
    assert.equal(badPhone.status, 400)
    assert.ok(Object.keys(badPhone.json.error.fields).includes("shippingAddress.phone"), "a Mumbai landline is not a delivery mobile")
    const none = new Browser()
    await none.add("kurta")
    const noAddress = await none.quote()
    assert.deepEqual([noAddress.status, noAddress.json.error.fields], [409, { shippingAddress: "required" }])
  })

  test("delivery: unserviceable PIN, courier outage, restricted item, no weight, over every courier's limit", async () => {
    assertBlocked(await new Browser().review({ items: [["kurta", 1]], pinCode: "110999", stateCode: "IN-DL" }), { field: "shipping", value: "pin_unserviceable", issue: "pin_unserviceable" })
    assertBlocked(await new Browser().review({ items: [["kurta", 1]], pinCode: "110998", stateCode: "IN-DL" }), { field: "shipping", value: "provider_unavailable", issue: "provider_unavailable" })
    assertBlocked(await new Browser().review({ items: [["ring", 1]] }), { field: "shipping", value: "category_restricted", issue: "category_restricted" })
    assertBlocked(await new Browser().review({ items: [["kurta", 1], ["unweighed", 1]] }), { field: "shipping", value: "parcel_unsupported", issue: "parcel_unsupported" })
    assertBlocked(await new Browser().review({ items: [["heavy", 1]] }), { field: "shipping", value: "parcel_unsupported", issue: "parcel_unsupported" })
  })

  test("price and stock: a stale bag, a price change after quoting, stock gone, an item withdrawn", async () => {
    const stale = new Browser()
    const first = await stale.review({ items: [["kurta", 1]] })
    await stale.add("kurta")
    const refused = await stale.quote({ cartRevision: first.quote.json.data.cartRevision })
    assert.deepEqual([refused.status, refused.json.error.fields.cartRevision], [409, "stale"])

    const moved = new Browser()
    const quoted = (await moved.review({ items: [["odd", 1]] })).quote.json.data
    await ctx.db.productVariant.update({ where: { id: v.odd.id }, data: { pricePaise: 89999n } })
    const check = await moved.call("GET", `/api/cart/quote/${quoted.id}`)
    await ctx.db.productVariant.update({ where: { id: v.odd.id }, data: { pricePaise: 99999n } })
    assert.deepEqual([check.status, check.json.error.fields.quote, check.json.error.fields.price], [409, "changed", "changed"])

    const short = new Browser()
    await short.add("scarce")
    await ctx.db.inventoryBalance.update({ where: { variantId: v.scarce.id }, data: { reserved: 1 } })
    const shortReview = await short.review({ items: [] })
    await ctx.db.inventoryBalance.update({ where: { variantId: v.scarce.id }, data: { reserved: 0 } })
    assertBlocked(shortReview, {})
    assert.deepEqual(Object.values(shortReview.error.fields), ["insufficient_stock"])

    const gone = new Browser()
    await gone.add("scarce")
    await ctx.db.productVariant.update({ where: { id: v.scarce.id }, data: { archivedAt: new Date() } })
    const goneReview = await gone.review({ items: [] })
    await ctx.db.productVariant.update({ where: { id: v.scarce.id }, data: { archivedAt: null } })
    assert.deepEqual(Object.values(goneReview.error.fields), ["unavailable"])
  })

  test("tax: a category with no rate in the profile, and production without an approved profile", async () => {
    assertBlocked(await new Browser().review({ items: [["wool", 1]] }), { field: "tax.apparel_wool", value: "unmapped_category" })
    const browser = new Browser()
    const ok = (await browser.review({ items: [["kurta", 1]] })).quote.json.data
    const cart = await ctx.db.cart.findUnique({ where: { id: ok.cartId } })
    const live = {
      gateway: {
        provider: "shiprocket",
        mode: "live",
        checkServiceability: async () => ({ serviceable: true, codAvailable: false, reason: "ok" }),
        quoteRates: async () => ({ status: "available", options: [{ serviceRef: "live-1", courierName: "Synthetic Live", rate: { amountPaise: 7000, currency: "INR" }, estimatedDeliveryDays: 3, quotedAt: new Date().toISOString(), mode: "surface", maxWeightGrams: 10000, maxDeclaredValuePaise: null, acceptsRestrictions: [] }], quotedAt: new Date().toISOString() }),
      },
      pickupPinCode: "560001",
    }
    await assert.rejects(quotes.quoteBag(ctx.db, { kind: "guest", guestSessionId: cart.guestSessionId }, {}, { env: { APP_ENV: "production" }, courier: live }), e => e.status === 409 && e.fields.tax === "no_active_profile" && e.message.length > 0)
  })

  test("an expired quote is refused and must be asked for again", async () => {
    const browser = new Browser()
    const q = (await browser.review({ items: [["kurta", 1]] })).quote.json.data
    const cart = await ctx.db.cart.findUnique({ where: { id: q.cartId } })
    await assert.rejects(quotes.checkQuote(ctx.db, { kind: "guest", guestSessionId: cart.guestSessionId }, q.id, { now: new Date(new Date(q.expiresAt).getTime()) }), e => e.status === 409 && e.fields.quote === "expired")
    assert.equal((await browser.call("GET", `/api/cart/quote/${q.id}`)).status, 404)
    assert.equal((await browser.quote()).status, 200, "a new quote can be asked for")
  })
})

describe("CHV-S12-M13 payment stays disabled", () => {
  test("no payment, order or webhook route exists on the API or the web host; no order, payment or reservation was made", async () => {
    const api = JSON.parse(readFileSync(join(ROOT, "packages/contracts/openapi/api.json"), "utf8"))
    assert.deepEqual(Object.keys(api.paths).filter(p => /payment|webhook|checkout|confirm/i.test(p)), [])
    assert.deepEqual(Object.keys(api.paths).filter(p => /quote/.test(p)).sort(), ["/api/v1/cart/quote", "/api/v1/cart/quote/{quoteId}"])
    // Order writes: claiming an existing guest order into an account (Stage 07), and since Stage 13.02 the
    // order intent, which places a pending order from a checked quote outside production only and takes
    // no payment (tests/security/orders/intent.test.mjs), and since 13.09 the shopper's cancellation of an
    // unpaid order (tests/security/orders/cancel.test.mjs). The staff contact read (13.12) is a POST only so it
    // passes the same-origin check; it changes no order, only records who read the buyer's details
    // (tests/security/orders/admin-orders.test.mjs). Since 13.13 admins and owners can hold, release and
    // note an order; none of these moves its status, payment or stock (tests/security/orders/admin-actions.test.mjs).
    // Since 13.14 they can close an order recovery case, which changes nothing on the order (recovery.test.mjs).
    assert.deepEqual(Object.entries(api.paths).filter(([p, ops]) => /order/.test(p) && Object.keys(ops).some(m => m !== "get")).map(([p]) => p).sort(), ["/api/v1/account/claim-order", "/api/v1/admin/order-recovery/cases/{caseId}/resolve", "/api/v1/admin/orders/{orderId}/contact", "/api/v1/admin/orders/{orderId}/hold", "/api/v1/admin/orders/{orderId}/notes", "/api/v1/admin/orders/{orderId}/release", "/api/v1/cart/order", "/api/v1/cart/order/{orderId}/cancel"])
    for (const server of [DEV, PROD]) {
      for (const path of ["/payment", "/api/payments", "/api/checkout", "/api/cart/checkout", "/api/cart/quote/confirm", "/api/orders", "/api/webhooks/razorpay"]) {
        const res = await new Browser(server).call(path.startsWith("/api") ? "POST" : "GET", path, path.startsWith("/api") ? {} : undefined)
        assert.ok([401, 404, 405].includes(res.status), `${path} on ${server.port} answered ${res.status}`)
      }
    }
    assert.deepEqual(
      { orders: await ctx.db.order.count(), payments: await ctx.db.paymentAttempt.count(), reservations: await ctx.db.inventoryReservation.count(), providerEvents: await ctx.db.providerEvent.count(), shipments: await ctx.db.shipment.count() },
      { orders: 0, payments: 0, reservations: 0, providerEvents: 0, shipments: 0 },
    )
  })

  test("the review's final button is disabled; production has no review page and keeps the bag's 'Checkout opens soon'", async () => {
    const review = readFileSync(join(ROOT, "components/checkout/checkout-review.tsx"), "utf8")
    assert.match(review, /<Button className="mt-6 h-13 w-full" disabled data-can-proceed=\{proceed \? "yes" : "no"\}>\s*<Lock[^>]*\/>\s*Payment opens soon/s)
    assert.doesNotMatch(review, /\/api\/(payments|orders|checkout)|razorpay|phonepe/i)
    assert.equal((await new Browser(PROD).call("GET", "/checkout")).status, 404)
    assert.equal((await new Browser(DEV).call("GET", "/checkout")).status, 200)
    const sheet = readFileSync(join(ROOT, "components/cart/cart-sheet.tsx"), "utf8")
    assert.match(sheet, /<Button[^>]*disabled[^>]*>\s*Checkout opens soon/s)
    for (const path of ["/", "/checkout"]) {
      const html = (await new Browser(DEV).call("GET", path)).text.toLowerCase()
      for (const provider of ["razorpay", "phonepe", "checkout.js"]) assert.ok(!html.includes(provider), `${path} loads no ${provider}`)
    }
  })
})
