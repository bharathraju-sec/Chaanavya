// CHV-S12-M08: the sandbox courier (apps/api/src/shipping/sandbox-courier.ts), the test/live split
// (apps/api/src/shipping/courier.ts, GET /api/cart/shipping-rates) and how the bag shows the answer
// (lib/shipping-rates.ts). The sandbox is deterministic; it is never chosen in production; its rates
// are always "test", its delivery answer never makes a bag deliverable or eligible to ship; and the
// bag labels every test price as a test rate while live prices carry no test wording. Couriers here
// are the sandbox or fakes; no price is real.
import { after, before, describe, test } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { apiModule, call, Jar, newIp, setup } from "../auth/helpers.mjs"
import { describeShipping, TEST_BADGE, TEST_NOTICE } from "../../../lib/shipping-rates.ts"

let ctx, forward, sandbox, courier, rates
const variants = {}
const NOW = new Date("2026-10-27T10:00:00.000Z")
const at = () => NOW

const api = (method, path, { jar, body, headers = {} } = {}) => call(forward, `/api/cart${path}`, { method, jar, body, headers, ip: newIp() })
const add = (jar, variantId, quantity = 1) => api("POST", "/lines", { jar, body: { variantId, quantity }, headers: { "idempotency-key": randomUUID() } })
const address = (pinCode = "560034", stateCode = "IN-KA") => ({ name: "Synthetic Guest", phone: "+91 60000 00000", line1: "1 Example Road", line2: null, landmark: null, city: "Bengaluru", district: "Bengaluru Urban", stateCode, pinCode })
const shippingRates = jar => api("GET", "/shipping-rates", { jar })

async function guestBag(items, pinCode) {
  const jar = new Jar()
  for (const [key, quantity] of items) assert.equal((await add(jar, variants[key], quantity)).status, 200)
  if (pinCode) assert.equal((await api("PUT", "/contact", { jar, body: { email: "guest@example.com", shippingAddress: address(pinCode) } })).status, 200)
  return jar
}

async function fixture(key, { weightGrams, restriction, pricePaise = 189900n }) {
  const product = await ctx.db.product.create({
    data: { handle: `fixture-${key}`, title: `Fixture ${key}`, status: "active", publishedAt: new Date(), shippingRestriction: restriction, variants: { create: [{ sku: `fixture-${key}-m`, title: "M", optionKey: "size:m", pricePaise, weightGrams }] } },
    include: { variants: true },
  })
  variants[key] = product.variants[0].id
  await ctx.db.inventoryBalance.create({ data: { variantId: variants[key], onHand: 50, lastCountedAt: new Date() } })
}

const parcel = (overrides = {}) => ({ weightGrams: 400, dimensionsMm: null, declaredValuePaise: 189900, restrictions: [], items: [{ sku: "KURTA-M", quantity: 1 }], ...overrides })
const request = (deliveryPinCode, overrides = {}) => ({ pickupPinCode: sandbox.SANDBOX_PICKUP_PIN, deliveryPinCode, deliveryStateCode: "IN-KA", parcel: parcel(overrides), paymentMode: "prepaid" })

/** A fake live courier: answers like a connected courier would. */
const liveGateway = (options = [{ serviceRef: "live-surface-1", courierName: "Synthetic Live", rate: { amountPaise: 7200, currency: "INR" }, estimatedDeliveryDays: 4, quotedAt: NOW.toISOString(), mode: "surface", maxWeightGrams: 10000, maxDeclaredValuePaise: null, acceptsRestrictions: [] }]) => ({
  provider: "shiprocket",
  mode: "live",
  checkServiceability: async () => ({ serviceable: true, codAvailable: false, reason: "ok" }),
  quoteRates: async () => ({ status: "available", options, quotedAt: NOW.toISOString() }),
})

before(async () => {
  ctx = await setup("chaanavya_test_s12_sandbox_courier")
  forward = ctx.routes.me.GET
  sandbox = await apiModule("shipping/sandbox-courier")
  courier = await apiModule("shipping/courier")
  rates = await apiModule("shipping/rates")
  await fixture("kurta", { weightGrams: 400, restriction: "none" })
  await fixture("oud", { weightGrams: 350, restriction: "fragrance_liquid", pricePaise: 249900n })
  await fixture("ring", { weightGrams: 50, restriction: "jewellery_high_value", pricePaise: 1299900n })
  await fixture("unweighed", { weightGrams: null, restriction: "none" })
})
after(() => ctx?.teardown())

describe("CHV-S12-M08 the sandbox courier is deterministic and only simulates", () => {
  test("the same request always gets the same answer; prices follow zone and 500 g slabs", async () => {
    const gw = sandbox.sandboxCourier({ now: at })
    assert.equal(gw.mode, "test")
    assert.equal(gw.provider, "sandbox")
    const first = await gw.quoteRates(request("560034"))
    assert.deepEqual(await gw.quoteRates(request("560034")), first)
    assert.deepEqual(await sandbox.sandboxCourier({ now: at }).quoteRates(request("560034")), first, "a fresh sandbox answers the same")
    const price = async (pin, weightGrams) => Object.fromEntries((await gw.quoteRates(request(pin, { weightGrams }))).options.map(o => [o.serviceRef, o.rate.amountPaise]))
    assert.deepEqual(await price("560034", 400), { "sandbox:surface": 3000, "sandbox:air": 5000 }, "local")
    assert.deepEqual(await price("580001", 400), { "sandbox:surface": 4500, "sandbox:air": 7000 }, "regional")
    assert.deepEqual(await price("110001", 400), { "sandbox:surface": 6000, "sandbox:air": 9000 }, "national")
    assert.deepEqual(await price("110001", 1200), { "sandbox:surface": 10000, "sandbox:air": 17000 }, "1.2 kg is three slabs")
    assert.ok(first.options.every(o => sandbox.isSandboxServiceRef(o.serviceRef) && o.courierName.startsWith("Sandbox ")))
  })

  test("documented PINs simulate an unserviceable address and an outage; other couriers' work is not simulated", async () => {
    const gw = sandbox.sandboxCourier({ now: at })
    assert.deepEqual(await gw.quoteRates(request("110999")), { status: "unavailable", reason: "pin_unserviceable", options: [], quotedAt: NOW.toISOString() })
    assert.equal((await gw.quoteRates(request("110998"))).reason, "provider_unavailable")
    assert.equal((await gw.checkServiceability({ pickupPinCode: "560001", deliveryPinCode: "110999", weightGrams: 400, categories: [] })).serviceable, false)
    assert.deepEqual(await gw.checkServiceability({ pickupPinCode: "560001", deliveryPinCode: "110001", weightGrams: 400, categories: [] }), { serviceable: true, codAvailable: false, reason: "ok" })
    for (const method of ["createShipment", "assignCourier", "schedulePickup", "getLabel", "cancelShipment", "track", "createReversePickup", "getRates"]) await assert.rejects(gw[method]({}), /sandbox courier/, method)
    assert.deepEqual(await gw.validateWebhook({ rawBody: "{}", headers: {} }), { valid: false })
  })

  test("sandbox answers still pass the server's checks: perfume never goes by air, jewellery has no service", async () => {
    const gw = sandbox.sandboxCourier({ now: at })
    const perfume = await rates.quoteParcel(gw, request("560034", { restrictions: ["fragrance_liquid"] }), { now: at })
    assert.deepEqual(perfume.options.map(o => o.serviceRef), ["sandbox:surface"])
    assert.equal((await rates.quoteParcel(gw, request("560034", { restrictions: ["jewellery_high_value"] }), { now: at })).reason, "category_restricted")
    assert.equal((await rates.quoteParcel(gw, request("560034", { weightGrams: 25000 }), { now: at })).reason, "parcel_unsupported")
  })
})

describe("CHV-S12-M08 simulation is kept apart from live eligibility", () => {
  test("development and staging use the sandbox; production never does, even when it is handed one", () => {
    assert.equal(courier.courierFor({ APP_ENV: "development" }).gateway.provider, "sandbox")
    assert.equal(courier.courierFor({ VERCEL_ENV: "preview" }).gateway.mode, "test", "staging")
    assert.equal(courier.courierFor({ APP_ENV: "production" }), null, "no live courier is connected")
    assert.equal(courier.courierFor({ VERCEL_ENV: "production" }), null)
    assert.equal(courier.courierFor({ APP_ENV: "production" }, { gateway: sandbox.sandboxCourier(), pickupPinCode: "560001" }), null, "a sandbox is refused in production")
    assert.equal(courier.courierFor({ APP_ENV: "production" }, { gateway: { ...liveGateway(), mode: "test" }, pickupPinCode: "560001" }), null, "a test-mode courier is refused in production")
    const live = { gateway: liveGateway(), pickupPinCode: "560001" }
    assert.equal(courier.courierFor({ APP_ENV: "production" }, live), live)
  })

  test("the bag's rates come from the sandbox as test rates: delivery is simulated, never deliverable or eligible", async () => {
    const jar = await guestBag([["kurta", 2]], "560034")
    const before = { orders: await ctx.db.order.count(), reservations: await ctx.db.inventoryReservation.count(), shipments: await ctx.db.shipment.count() }
    const response = await shippingRates(jar)
    assert.equal(response.status, 200, JSON.stringify(response.json))
    assert.equal(response.response.headers.get("cache-control"), "no-store")
    const data = response.json.data
    assert.equal(data.mode, "test")
    assert.deepEqual(data.delivery, { pinCode: "560034", format: "valid", delivery: "serviceable", deliverable: false, source: "test" })
    assert.equal(data.liveEligible, false)
    assert.equal(data.quote.status, "available")
    assert.deepEqual(data.quote.options.map(o => [o.serviceRef, o.rate.amountPaise]), [["sandbox:surface", 5000], ["sandbox:air", 9000]], "800 g is two slabs, local, cheapest first")
    assert.deepEqual({ orders: await ctx.db.order.count(), reservations: await ctx.db.inventoryReservation.count(), shipments: await ctx.db.shipment.count() }, before, "nothing is booked or reserved")
  })

  test("the catalogue decides the parcel: perfume gets surface only, jewellery and unweighed items get no rate", async () => {
    const perfume = (await shippingRates(await guestBag([["oud", 1]], "560034"))).json.data
    assert.deepEqual(perfume.quote.options.map(o => o.serviceRef), ["sandbox:surface"])
    const ring = (await shippingRates(await guestBag([["ring", 1]], "560034"))).json.data
    assert.deepEqual([ring.quote.status, ring.quote.reason, ring.quote.options], ["unavailable", "category_restricted", []])
    const unweighed = (await shippingRates(await guestBag([["kurta", 1], ["unweighed", 1]], "560034"))).json.data
    assert.deepEqual([unweighed.quote.reason, unweighed.quote.options, unweighed.liveEligible], ["parcel_unsupported", [], false])
  })

  test("an address the sandbox does not serve, or a simulated outage, gives no rate", async () => {
    const far = (await shippingRates(await guestBag([["kurta", 1]], "110999"))).json.data
    assert.deepEqual([far.delivery.delivery, far.delivery.source, far.quote.reason, far.quote.options], ["not_serviceable", "test", "pin_unserviceable", []])
    const down = (await shippingRates(await guestBag([["kurta", 1]], "110998"))).json.data
    assert.deepEqual([down.delivery.delivery, down.quote.reason, down.quote.options], ["unknown", "provider_unavailable", []])
  })

  test("no bag is 404, no delivery address is 409; the browser cannot choose the courier or the parcel", async () => {
    assert.equal((await shippingRates(new Jar())).status, 404)
    const noAddress = await shippingRates(await guestBag([["kurta", 1]]))
    assert.equal(noAddress.status, 409)
    assert.deepEqual(noAddress.json.error.fields, { shippingAddress: "required" })
    const jar = await guestBag([["kurta", 1]], "560034")
    const tampered = await call(forward, "/api/cart/shipping-rates?mode=live&weightGrams=1&courier=shiprocket", { method: "GET", jar, ip: newIp() })
    assert.equal(tampered.json.data.mode, "test")
    assert.equal(tampered.json.data.liveEligible, false)
    assert.equal(tampered.json.data.quote.options[0].rate.amountPaise, 3000)
  })

  test("only a live courier's answer makes a bag eligible; a live answer carrying a sandbox service is not trusted", async () => {
    const jar = await guestBag([["kurta", 1]], "560034")
    const cart = await ctx.db.cart.findFirst({ where: { contact: { isNot: null } }, orderBy: { createdAt: "desc" } })
    const owner = { kind: "guest", guestSessionId: cart.guestSessionId }
    assert.ok(jar.has("chaanavya_guest"))
    const live = await courier.shippingRatesFor(ctx.db, owner, { gateway: liveGateway(), pickupPinCode: "560001" }, NOW)
    assert.deepEqual([live.mode, live.delivery.source, live.delivery.deliverable, live.liveEligible], ["live", "live", true, true])
    const sandboxAsLive = await courier.shippingRatesFor(ctx.db, owner, { gateway: liveGateway([{ serviceRef: "sandbox:surface", courierName: "Sandbox Surface", rate: { amountPaise: 3000, currency: "INR" }, estimatedDeliveryDays: 2, quotedAt: NOW.toISOString(), mode: "surface", maxWeightGrams: 20000, maxDeclaredValuePaise: null, acceptsRestrictions: [] }]), pickupPinCode: "560001" }, NOW)
    assert.deepEqual([sandboxAsLive.quote.status, sandboxAsLive.quote.reason, sandboxAsLive.liveEligible], ["unavailable", "provider_unavailable", false])
    const sandboxed = await courier.shippingRatesFor(ctx.db, owner, { gateway: sandbox.sandboxCourier({ now: at }), pickupPinCode: "560001" }, NOW)
    assert.deepEqual([sandboxed.mode, sandboxed.delivery.deliverable, sandboxed.liveEligible], ["test", false, false])
    const none = await courier.shippingRatesFor(ctx.db, owner, null, NOW)
    assert.deepEqual(none, { mode: "none", delivery: { pinCode: "560034", format: "valid", delivery: "unknown", deliverable: false, source: "none" }, quote: null, liveEligible: false, restrictedItems: [] })
  })
})

describe("CHV-S12-M08 the bag shows test rates as test rates and live rates plainly", () => {
  const option = (serviceRef, courierName, amountPaise, estimatedDeliveryDays) => ({ serviceRef, courierName, rate: { amountPaise, currency: "INR" }, estimatedDeliveryDays, quotedAt: NOW.toISOString(), mode: "surface", maxWeightGrams: 20000, maxDeclaredValuePaise: null, acceptsRestrictions: [] })
  const answer = (mode, source = mode) => ({
    mode,
    delivery: { pinCode: "560034", format: "valid", delivery: "serviceable", deliverable: mode === "live", source },
    quote: { status: "available", options: [option(`${mode === "test" ? "sandbox:" : "live-"}surface`, mode === "test" ? "Sandbox Surface" : "Synthetic Live", 4000, 2), option(`${mode === "test" ? "sandbox:" : "live-"}air`, mode === "test" ? "Sandbox Air" : "Synthetic Air", 9000, 1)] },
    quotedAt: NOW.toISOString(),
    liveEligible: mode === "live",
  })
  const words = display => JSON.stringify(display, (key, value) => (key === "testRate" ? undefined : value)).toLowerCase()

  test("test rates carry the badge, the notice and a label on every price; delivery is worded as simulated", () => {
    const shown = describeShipping(answer("test"))
    assert.equal(shown.kind, "test")
    assert.equal(shown.badge, TEST_BADGE)
    assert.equal(shown.notice, TEST_NOTICE)
    assert.match(shown.notice, /not real delivery prices/)
    assert.match(shown.heading, /test rates/i)
    assert.equal(shown.rows.length, 2)
    assert.ok(shown.rows.every(r => r.testRate), "every price is marked a test rate")
    assert.deepEqual(shown.rows.map(r => r.price), ["₹40", "₹90"])
    assert.match(shown.delivery, /^Simulated:/)
    assert.doesNotMatch(shown.delivery, /^Delivers to/)
  })

  test("live rates carry no test wording at all", () => {
    const shown = describeShipping(answer("live"))
    assert.equal(shown.kind, "live")
    assert.equal(shown.badge, null)
    assert.equal(shown.notice, null)
    assert.ok(shown.rows.every(r => !r.testRate))
    assert.doesNotMatch(words(shown), /test|sandbox|simulat/)
    assert.equal(shown.delivery, "Delivers to 560034.")
  })

  test("the label follows the API's mode alone: a test answer dressed as live is still shown as a test", () => {
    const forged = { ...answer("test"), liveEligible: true, delivery: { ...answer("test").delivery, deliverable: true, source: "live" } }
    const shown = describeShipping(forged)
    assert.equal(shown.kind, "test")
    assert.ok(shown.rows.every(r => r.testRate))
    assert.equal(describeShipping({ ...answer("test"), mode: "unexpected" }).kind, "test", "anything not live is shown as a test")
  })

  test("every delivery answer has its own wording; only a live deliverable answer says 'Delivers to'", () => {
    const at = (mode, delivery, deliverable = false) => describeShipping({ ...answer(mode), delivery: { pinCode: "560034", format: "valid", delivery, deliverable, source: mode } }).delivery
    assert.equal(at("test", "not_serviceable"), "Simulated: the sandbox courier does not deliver to 560034.")
    assert.equal(at("test", "unknown"), "Simulated: no sandbox answer for 560034.")
    assert.equal(at("live", "serviceable", true), "Delivers to 560034.")
    assert.equal(at("live", "not_serviceable"), "We don't deliver to 560034 yet.")
    assert.equal(at("live", "unknown"), "Delivery to 560034 is not confirmed yet.")
    assert.equal(at("live", "serviceable", false), "Delivery to 560034 is not confirmed yet.", "serviceable but not deliverable is not a promise")
  })

  test("no courier shows nothing; no rate shows the reason, never a price", () => {
    assert.deepEqual(describeShipping({ mode: "none", delivery: answer("live").delivery, quote: null, liveEligible: false }), { kind: "hidden" })
    assert.deepEqual(describeShipping(null), { kind: "hidden" })
    const none = describeShipping({ ...answer("test"), quote: { status: "unavailable", reason: "category_restricted", options: [], quotedAt: NOW.toISOString() } })
    assert.deepEqual(none.rows, [])
    assert.match(none.unavailable, /cannot be sent/)
    assert.equal(none.badge, TEST_BADGE)
  })
})
