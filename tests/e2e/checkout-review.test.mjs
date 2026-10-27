// CHV-S12-M11 (Stage 12.11): the checkout review page shows the shopper exactly the total the API
// authorised. Real HTTP against the production build (`npm run build` first): one `next start` as
// development and one as production, both in front of the API running in-process on a throwaway
// database. The review page (app/(store)/checkout, components/checkout/checkout-review.tsx) makes
// exactly the calls below; what it shows is lib/checkout.ts's reviewSummary of the API's quote,
// which formats the API's amounts and adds nothing up. Production has no review page (owner
// decision, 27 October 2026). Delivery is the sandbox courier; tax values are synthetic.
import { after, before, describe, test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { ROOT } from "../integration/database/helpers.mjs"
import { createStaff, setup } from "../security/auth/helpers.mjs"
import { checkoutReviewOpen, reviewSummary } from "../../lib/checkout.ts"
import { formatMoney } from "../../lib/types.ts"

const DEV = { port: 5667 }
const PROD = { port: 5668 }
let ctx
let variantId

const url = server => `http://127.0.0.1:${server.port}`

/** A tiny browser on one web host: keeps cookies and sends what a same-origin fetch sends. */
class Browser {
  cookies = new Map()
  constructor(server) {
    this.web = url(server)
  }
  async call(method, path, body, headers = {}) {
    const h = { accept: "application/json", "sec-fetch-site": "same-origin", origin: this.web, ...headers }
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
    return { status: res.status, json, text, headers: res.headers }
  }
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

const address = { name: "Synthetic Guest", phone: "+91 60000 00000", line1: "1 Example Road", line2: null, landmark: null, city: "Example City", district: "Example District", stateCode: "IN-KA", pinCode: "560034" }

/** The review page's own calls, in its order: bag, contact, delivery options, quote. */
async function review(browser, serviceRef = null) {
  const bag = (await browser.call("GET", "/api/cart")).json.data
  assert.equal((await browser.call("PUT", "/api/cart/contact", { email: "guest@example.com", shippingAddress: address })).status, 200)
  const rates = (await browser.call("GET", "/api/cart/shipping-rates")).json.data
  const quote = await browser.call("POST", "/api/cart/quote", { serviceRef, cartRevision: bag.revision })
  assert.equal(quote.status, 200, JSON.stringify(quote.json))
  return { bag, rates, quote: quote.json.data }
}

before(async () => {
  assert.ok(existsSync(join(ROOT, ".next", "BUILD_ID")), "run `npm run build` before the page tests")
  ctx = await setup("chaanavya_test_s12_checkout_review")
  const { user } = await createStaff(ctx, "s12.review.owner@example.com", "OWNER")
  await ctx.db.taxProfile.create({ data: { sellerStateCode: "IN-KA", pricesIncludeTax: true, note: "synthetic test values", createdById: user.id, rates: { create: [{ taxCategory: "apparel_cotton", hsnCode: "6204", rateBasisPoints: 500 }] } } })
  const product = await ctx.db.product.create({
    data: { handle: "fixture-review-kurta", title: "Fixture review kurta", status: "active", publishedAt: new Date(), shippingRestriction: "none", variants: { create: [{ sku: "fixture-review-kurta-m", title: "M", optionKey: "size:m", pricePaise: 189900n, taxCategory: "apparel_cotton", weightGrams: 400 }] } },
    include: { variants: true },
  })
  variantId = product.variants[0].id
  await ctx.db.inventoryBalance.create({ data: { variantId, onHand: 20, lastCountedAt: new Date() } })
  await ctx.db.promotion.create({ data: { code: "REVIEW10", kind: "percent", percentBasisPoints: 1000, startsAt: new Date(Date.now() - 86_400_000), active: true } })
  await Promise.all([start(DEV, "development"), start(PROD, "production")])
})
after(async () => {
  DEV.proc?.kill()
  PROD.proc?.kill()
  await ctx?.teardown()
})

describe("CHV-S12-M11 the review shows exactly the total the API authorised", () => {
  test("through the web host, the shown total is the API's grand total, and it matches the stored quote", async () => {
    const browser = new Browser(DEV)
    assert.equal((await browser.call("POST", "/api/cart/lines", { variantId, quantity: 2 }, { "idempotency-key": randomUUID() })).status, 200)
    assert.equal((await browser.call("POST", "/api/cart/promotion", { code: "REVIEW10" })).status, 200)
    const { quote } = await review(browser)
    const shown = reviewSummary(quote)
    assert.equal(shown.total, formatMoney(quote.grandTotal.amountPaise / 100))
    assert.equal(shown.total, "₹3,468.20", "2 × 1,899.00, minus 10%, plus 50.00 sandbox surface delivery (800 g, two slabs)")
    const stored = await ctx.db.checkoutQuote.findUnique({ where: { id: quote.id } })
    assert.equal(Number(stored.grandTotalPaise), quote.grandTotal.amountPaise, "what is shown is what the API stored")
    const checked = await browser.call("GET", `/api/cart/quote/${quote.id}`)
    assert.equal(checked.status, 200)
    assert.equal(reviewSummary(checked.json.data.quote).total, shown.total, "the quote check agrees")
    assert.deepEqual(
      shown.rows.map(r => [r.label, r.amount]),
      [
        ["Subtotal", formatMoney(quote.subtotal.amountPaise / 100)],
        ["Discount", `minus ${formatMoney(quote.discountTotal.amountPaise / 100)}`],
        ["Delivery", formatMoney(quote.shipping.total.amountPaise / 100)],
        ["GST included", formatMoney(quote.taxTotal.amountPaise / 100)],
      ],
    )
    assert.deepEqual(shown.lines.map(l => [l.quantity, l.unitPrice, l.lineTotal]), quote.lines.map(l => [l.quantity, formatMoney(l.unitPrice.amountPaise / 100), formatMoney(l.lineTotal.amountPaise / 100)]))
  })

  test("choosing another delivery option shows the API's new total, not one worked out in the browser", async () => {
    const browser = new Browser(DEV)
    await browser.call("POST", "/api/cart/lines", { variantId, quantity: 1 }, { "idempotency-key": randomUUID() })
    const surface = (await review(browser)).quote
    const air = (await review(browser, "sandbox:air")).quote
    assert.deepEqual([reviewSummary(surface).total, reviewSummary(air).total], ["₹1,929", "₹1,949"], "the API's totals for each option")
    assert.equal((await browser.call("GET", `/api/cart/quote/${surface.id}`)).status, 404, "the earlier option's quote is replaced, never reused")
  })

  test("the summary only formats the API's figures: a quote whose parts do not add up still shows the API's total", () => {
    const money = amountPaise => ({ amountPaise, currency: "INR" })
    const quote = {
      version: 1,
      id: randomUUID(),
      cartId: randomUUID(),
      cartRevision: 1,
      lines: [{ variantId: randomUUID(), sku: "S", title: "T", variantTitle: "M", quantity: 1, unitPrice: money(100), lineSubtotal: money(100), discount: money(0), tax: [], lineTotal: money(100), classification: {} }],
      promotionId: null,
      subtotal: money(100),
      discountTotal: money(0),
      shippingFee: money(0),
      taxTotal: money(0),
      grandTotal: money(123456),
      pricesIncludeTax: true,
      courierQuoteRef: "x",
      expiresAt: new Date().toISOString(),
      shipping: { serviceRef: "x", courierName: "C", mode: "surface", estimatedDeliveryDays: 2, fee: money(0), tax: [], total: money(0) },
      supply: "intra",
      mode: "live",
      testReasons: [],
    }
    const shown = reviewSummary(quote)
    assert.equal(shown.total, "₹1,234.56", "never the sum of the rows (₹1)")
    assert.equal(shown.test, null)
    assert.ok(!shown.rows.some(r => r.label === "Discount"), "no discount row when there is none")
    const sources = ["components/checkout/checkout-review.tsx", "lib/checkout.ts"].map(f => readFileSync(join(ROOT, f), "utf8"))
    for (const source of sources) {
      assert.doesNotMatch(source, /amountPaise\s*[-+*]|[-+*]\s*\w+\.amountPaise|\.reduce\(/, "no money arithmetic in the review")
    }
    assert.match(sources[0], /reviewSummary\(quote\)/, "the page shows the summary of the API's quote")
    assert.match(sources[0], /data-total>\s*\{summary\.total\}\s*</, "the Total cell shows the API's grand total and nothing else")
  })

  test("a test quote says so on the summary; nothing on the page can place an order", async () => {
    const browser = new Browser(DEV)
    await browser.call("POST", "/api/cart/lines", { variantId, quantity: 1 }, { "idempotency-key": randomUUID() })
    const { quote } = await review(browser)
    assert.match(reviewSummary(quote).test, /^Test quote: delivery uses test rates from a sandbox courier, and GST uses a draft tax profile that is not approved\. Nothing can be ordered at these prices\.$/)
    const source = readFileSync(join(ROOT, "components/checkout/checkout-review.tsx"), "utf8")
    assert.match(source, /<Button[^>]*disabled[^>]*>\s*<Lock[^>]*\/>\s*Payment opens soon/s)
    assert.doesNotMatch(source, /\/api\/(checkout|orders|payments)/, "no order or payment call")
    assert.equal(await ctx.db.order.count(), 0)
    assert.equal(await ctx.db.inventoryReservation.count(), 0)
  })
})

describe("CHV-S12-M11 the review page is open in development and staging only", () => {
  test("development serves /checkout, not indexed; production answers 404", async () => {
    const dev = await new Browser(DEV).call("GET", "/checkout")
    assert.equal(dev.status, 200)
    assert.match(dev.text, /<meta name="robots" content="noindex, nofollow"/)
    assert.match(dev.text, /Review your order/)
    assert.equal((await new Browser(PROD).call("GET", "/checkout")).status, 404)
  })

  test("the switch: development and staging open, production closed however it is declared", () => {
    assert.equal(checkoutReviewOpen({ APP_ENV: "development" }), true)
    assert.equal(checkoutReviewOpen({ APP_ENV: "staging" }), true)
    assert.equal(checkoutReviewOpen({ VERCEL_ENV: "preview" }), true)
    assert.equal(checkoutReviewOpen({ APP_ENV: "production" }), false)
    assert.equal(checkoutReviewOpen({ VERCEL_ENV: "production" }), false)
    assert.equal(checkoutReviewOpen({ APP_ENV: " production " }), false)
  })

  test("the bag links to the review only when it is open; otherwise checkout stays a disabled button", () => {
    const sheet = readFileSync(join(ROOT, "components/cart/cart-sheet.tsx"), "utf8")
    assert.match(sheet, /checkoutOpen && lines\.length > 0 \?/)
    assert.match(sheet, /<Link href="\/checkout"/)
    assert.match(sheet, /<Button[^>]*disabled[^>]*>\s*Checkout opens soon/s)
    assert.match(readFileSync(join(ROOT, "app/(store)/store-shell.tsx"), "utf8"), /<CartSheet checkoutOpen=\{checkoutReviewOpen\(process\.env\)\} \/>/)
    assert.match(readFileSync(join(ROOT, "app/(store)/checkout/page.tsx"), "utf8"), /if \(!checkoutReviewOpen\(process\.env\)\) notFound\(\)/)
  })
})
