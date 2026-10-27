// CHV-S12-M12: checkout cannot go on to an address delivery does not serve (Stage 12.12). Through the
// web host's forwarder, exactly as the review page calls it: for an unserviceable PIN, a courier
// outage, a restricted item and an unpriceable parcel, the API gives no delivery option and no quote
// (nothing is stored), an earlier quote for the bag stops being valid, and the review
// (lib/checkout.ts deliveryIssue, canProceed) says why, offers the right action, shows no total and
// never words a courier failure as delivering or not delivering. Couriers here are the sandbox (PINs
// ending 999 are unserviceable, 998 simulate an outage) or fakes.
import { after, before, describe, test } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { ROOT } from "../../integration/database/helpers.mjs"
import { apiModule, call, createStaff, Jar, newIp, setup } from "../auth/helpers.mjs"
import { canProceed, deliveryIssue, reviewSummary } from "../../../lib/checkout.ts"

let ctx, forward, quotes
const v = {}

const api = (method, path, { jar, body } = {}) => call(forward, `/api/cart${path}`, { method, jar, body, headers: method === "POST" && path === "/lines" ? { "idempotency-key": randomUUID() } : {}, ip: newIp() })
const address = (pinCode, stateCode = "IN-DL") => ({ name: "Synthetic Guest", phone: "+91 60000 00000", line1: "1 Example Road", line2: null, landmark: null, city: "Example City", district: "Example District", stateCode, pinCode })

/** The review page's calls for a bag delivered to `pinCode`: rates, then the quote. */
async function review(items, pinCode, stateCode) {
  const jar = new Jar()
  for (const key of items) assert.equal((await api("POST", "/lines", { jar, body: { variantId: v[key], quantity: 1 } })).status, 200)
  assert.equal((await api("PUT", "/contact", { jar, body: { email: "guest@example.com", shippingAddress: address(pinCode, stateCode) } })).status, 200)
  return { jar, ...(await reprice(jar)) }
}
async function reprice(jar) {
  const rates = (await api("GET", "/shipping-rates", { jar })).json.data
  const quote = await api("POST", "/quote", { jar, body: {} })
  return { rates, quote, issue: deliveryIssue(rates, quote.status === 200 ? null : quote.json.error), proceed: canProceed(quote.status === 200 ? quote.json.data : null, deliveryIssue(rates, quote.status === 200 ? null : quote.json.error)) }
}

async function fixture(key, { restriction = "none", weightGrams = 400 } = {}) {
  const p = await ctx.db.product.create({
    data: { handle: `fixture-dfail-${key}`, title: `Fixture ${key}`, status: "active", publishedAt: new Date(), shippingRestriction: restriction, variants: { create: [{ sku: `fixture-dfail-${key}`, title: "M", optionKey: "size:m", pricePaise: 189900n, taxCategory: "apparel_cotton", weightGrams }] } },
    include: { variants: true },
  })
  v[key] = p.variants[0].id
  await ctx.db.inventoryBalance.create({ data: { variantId: v[key], onHand: 50, lastCountedAt: new Date() } })
}

/** No figure, and no wording that delivery happens or is refused, for a courier that did not answer. */
const words = issue => `${issue.title} ${issue.detail}`.toLowerCase()

before(async () => {
  ctx = await setup("chaanavya_test_s12_delivery_failure")
  forward = ctx.routes.me.GET
  quotes = await apiModule("checkout/quote")
  const { user } = await createStaff(ctx, "s12.dfail.owner@example.com", "OWNER")
  await ctx.db.taxProfile.create({ data: { sellerStateCode: "IN-KA", pricesIncludeTax: true, note: "synthetic test values", createdById: user.id, rates: { create: [{ taxCategory: "apparel_cotton", hsnCode: "6204", rateBasisPoints: 500 }] } } })
  await fixture("kurta")
  await fixture("ring", { restriction: "jewellery_high_value" })
  await fixture("unweighed", { weightGrams: null })
})
after(() => ctx?.teardown())

describe("CHV-S12-M12 an unserviceable route stops checkout", () => {
  test("a PIN the courier does not serve: no option, no quote stored, 'we don't deliver' with change-address", async () => {
    const before = await ctx.db.checkoutQuote.count()
    const { rates, quote, issue, proceed } = await review(["kurta"], "110999")
    assert.deepEqual([rates.delivery.delivery, rates.delivery.deliverable, rates.quote.options], ["not_serviceable", false, []])
    assert.deepEqual([quote.status, quote.json.error.fields.shipping], [409, "pin_unserviceable"])
    assert.equal(await ctx.db.checkoutQuote.count(), before, "no quote is stored for an unserviceable route")
    assert.equal(issue.kind, "pin_unserviceable")
    assert.equal(issue.title, "We don't deliver to 110999 yet")
    assert.deepEqual(issue.actions, ["change_address", "contact"])
    assert.equal(proceed, false)
  })

  test("a courier outage: 'could not check', with retry; never worded as delivering or refusing; retry recovers", async () => {
    const { jar, rates, quote, issue, proceed } = await review(["kurta"], "110998")
    assert.equal(rates.delivery.delivery, "unknown")
    assert.deepEqual([quote.status, quote.json.error.fields.shipping], [409, "provider_unavailable"])
    assert.equal(issue.kind, "provider_unavailable")
    assert.deepEqual(issue.actions, ["retry", "contact"])
    assert.match(issue.title, /couldn't check delivery to 110998/)
    assert.doesNotMatch(words(issue), /\bwe deliver\b|delivers to|don't deliver|do not deliver|not deliver/, "no claim either way")
    assert.equal(proceed, false)
    // Retry: the same bag and address, a courier that failed once and then answers.
    assert.equal((await api("PUT", "/contact", { jar, body: { email: "guest@example.com", shippingAddress: address("110001") } })).status, 200)
    const cart = await ctx.db.cart.findFirst({ where: { contact: { isNot: null } }, orderBy: { updatedAt: "desc" } })
    const owner = { kind: "guest", guestSessionId: cart.guestSessionId }
    let calls = 0
    const offer = { serviceRef: "live-1", courierName: "Synthetic Live", rate: { amountPaise: 7000, currency: "INR" }, estimatedDeliveryDays: 3, quotedAt: new Date().toISOString(), mode: "surface", maxWeightGrams: 10000, maxDeclaredValuePaise: null, acceptsRestrictions: [] }
    const flaky = {
      provider: "shiprocket",
      mode: "live",
      checkServiceability: async () => {
        calls += 1
        if (calls === 1) throw new Error("courier down")
        return { serviceable: true, codAvailable: false, reason: "ok" }
      },
      quoteRates: async () => ({ status: "available", options: [offer], quotedAt: new Date().toISOString() }),
    }
    const courier = { gateway: flaky, pickupPinCode: "560001" }
    await assert.rejects(quotes.quoteBag(ctx.db, owner, {}, { courier }), e => e.status === 409 && e.fields.shipping === "provider_unavailable", "first try: the courier is down, no quote")
    const retried = await quotes.quoteBag(ctx.db, owner, {}, { courier })
    assert.equal(retried.shippingFee.amountPaise, 7000, "the retry gets the courier's real offer")
    assert.equal(canProceed(retried, null), true)
  })

  test("a restricted item: no option, 'can't be sent' with edit-bag", async () => {
    const { quote, issue, proceed } = await review(["ring"], "110001")
    assert.deepEqual([quote.status, quote.json.error.fields.shipping], [409, "category_restricted"])
    assert.deepEqual([issue.kind, issue.actions], ["category_restricted", ["edit_bag", "change_address"]])
    assert.equal(proceed, false)
  })

  test("a bag with no weight: 'can't price delivery', with contact", async () => {
    const { quote, issue, proceed } = await review(["kurta", "unweighed"], "110001")
    assert.deepEqual([quote.status, quote.json.error.fields.shipping], [409, "parcel_unsupported"])
    assert.deepEqual([issue.kind, issue.actions], ["parcel_unsupported", ["contact", "edit_bag"]])
    assert.equal(proceed, false)
  })

  test("a served address goes on: a quote, no issue, a total", async () => {
    const { quote, issue, proceed } = await review(["kurta"], "110001")
    assert.equal(quote.status, 200)
    assert.equal(issue, null)
    assert.equal(proceed, true)
    assert.equal(reviewSummary(quote.json.data).total, "₹1,959", "1,899.00 plus 60.00 national surface")
  })

  test("moving a quoted bag to an unserviceable PIN invalidates the earlier quote; the new route gets none", async () => {
    const { jar, quote } = await review(["kurta"], "110001")
    assert.equal(quote.status, 200)
    assert.equal((await api("PUT", "/contact", { jar, body: { email: "guest@example.com", shippingAddress: address("110999") } })).status, 200)
    const checked = await api("GET", `/quote/${quote.json.data.id}`, { jar })
    assert.equal(checked.status, 409)
    assert.equal(checked.json.error.fields.quote, "changed")
    assert.equal(checked.json.error.fields.delivery, "changed", "the courier no longer offers delivery there")
    assert.equal((await api("POST", "/quote", { jar, body: {} })).status, 409)
    assert.equal(await ctx.db.checkoutQuote.count({ where: { id: quote.json.data.id } }), 0)
  })

  test("a live courier that says not serviceable, or fails, is treated the same; production without a courier cannot quote", async () => {
    const { jar, quote } = await review(["kurta"], "110001")
    assert.equal(quote.status, 200)
    const cart = await ctx.db.cart.findUnique({ where: { id: quote.json.data.cartId } })
    const owner = { kind: "guest", guestSessionId: cart.guestSessionId }
    assert.ok(jar.has("chaanavya_guest"))
    const refusing = { provider: "shiprocket", mode: "live", checkServiceability: async () => ({ serviceable: false, codAvailable: false, reason: "pin_unserviceable" }), quoteRates: async () => ({ status: "unavailable", reason: "pin_unserviceable", options: [], quotedAt: new Date().toISOString() }) }
    await assert.rejects(quotes.quoteBag(ctx.db, owner, {}, { courier: { gateway: refusing, pickupPinCode: "560001" } }), e => e.status === 409 && e.fields.shipping === "pin_unserviceable")
    const failing = { provider: "shiprocket", mode: "live", checkServiceability: async () => { throw new Error("down") }, quoteRates: async () => { throw new Error("down") } }
    await assert.rejects(quotes.quoteBag(ctx.db, owner, {}, { courier: { gateway: failing, pickupPinCode: "560001" } }), e => e.status === 409 && e.fields.shipping === "provider_unavailable")
    // A live courier that offers a price but says the PIN is not served never gets a quote.
    const contradictory = { ...refusing, quoteRates: async () => ({ status: "available", options: [{ serviceRef: "live-1", courierName: "Synthetic Live", rate: { amountPaise: 5000, currency: "INR" }, estimatedDeliveryDays: 3, quotedAt: new Date().toISOString(), mode: "surface", maxWeightGrams: 10000, maxDeclaredValuePaise: null, acceptsRestrictions: [] }], quotedAt: new Date().toISOString() }) }
    await assert.rejects(quotes.quoteBag(ctx.db, owner, {}, { courier: { gateway: contradictory, pickupPinCode: "560001" } }), e => e.status === 409 && e.fields.shipping === "pin_unserviceable")
    await assert.rejects(quotes.quoteBag(ctx.db, owner, {}, { env: { APP_ENV: "production" } }), e => e.status === 409 && e.fields.shipping === "no_courier")
    const none = deliveryIssue({ mode: "none", delivery: { pinCode: "110001", format: "valid", delivery: "unknown", deliverable: false, source: "none" }, quote: null, liveEligible: false }, { fields: { shipping: "no_courier" } })
    assert.deepEqual([none.kind, none.actions], ["no_courier", ["contact"]])
  })
})

describe("CHV-S12-M12 the review never shows a total or a delivery claim it does not have", () => {
  test("rates that could not be loaded are an outage, not a refusal; no issue only with a served answer", () => {
    assert.equal(deliveryIssue(null, null).kind, "provider_unavailable")
    assert.equal(canProceed(null, null), false, "no quote, no checkout")
    const served = { mode: "test", delivery: { pinCode: "560034", format: "valid", delivery: "serviceable", deliverable: false, source: "test" }, quote: { status: "available", options: [{}], quotedAt: "" }, liveEligible: false }
    assert.equal(deliveryIssue(served, null), null)
    assert.equal(deliveryIssue(served, { fields: { shipping: "pin_unserviceable" } }).kind, "pin_unserviceable", "a quote refusal wins over an earlier rates answer")
    assert.equal(deliveryIssue(served, { fields: { "lines.x": "insufficient_stock" } }), null, "stock is not a delivery problem")
  })

  test("a quote that arrives while delivery is blocked still cannot go on (rates failed, the quote call a moment later did not)", async () => {
    const { quote } = await review(["kurta"], "110001")
    assert.equal(quote.status, 200)
    const outage = deliveryIssue(null, null)
    assert.equal(canProceed(quote.json.data, outage), false)
    assert.equal(canProceed(quote.json.data, deliveryIssue({ mode: "test", delivery: { pinCode: "110001", format: "valid", delivery: "not_serviceable", deliverable: false, source: "test" }, quote: { status: "unavailable", reason: "pin_unserviceable", options: [], quotedAt: "" }, liveEligible: false }, null)), false)
    assert.equal(canProceed(quote.json.data, null), true)
  })

  test("the page shows the issue, hides the total and keeps the order button disabled while delivery is blocked", () => {
    const source = readFileSync(join(ROOT, "components/checkout/checkout-review.tsx"), "utf8")
    assert.match(source, /const issue = contact && !pricing \? deliveryIssue\(rates, quoteError\) : null/)
    assert.match(source, /const summary = quote && proceed \? reviewSummary\(quote\) : null/, "no summary, so no total, unless checkout can go on")
    assert.match(source, /\) : issue \? \(\s*<IssueCard issue=\{issue\}/, "the issue replaces the delivery options")
    assert.match(source, /<Button className="mt-6 h-13 w-full" disabled data-can-proceed=/)
    assert.match(source, /action === "retry" && bag\) void price\(bag\.revision, choice\.current\)/, "retry asks the API again")
  })
})
