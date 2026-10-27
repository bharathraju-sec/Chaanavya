// CHV-S12-M07: courier rates (apps/api/src/shipping/rates.ts and the RateRequestV1 / RateQuoteV1
// contract). An unsupported parcel never receives an invented service offer: a parcel missing a
// weight or a reviewed restriction is never quoted, an offer that cannot carry the parcel (too heavy,
// too valuable, a restriction it does not accept, a malformed or non-INR rate) is dropped, a courier
// error or timeout gives no offer, and an unavailable quote never carries an option. Couriers here
// are fakes; no rate is real.
import { before, describe, test } from "node:test"
import assert from "node:assert/strict"
import { apiModule } from "../auth/helpers.mjs"

let rates

const NOW = new Date("2026-10-27T10:00:00.000Z")
const line = (overrides = {}) => ({ sku: "KURTA-M", quantity: 1, weightGrams: 400, unitPricePaise: 189900n, restriction: "none", ...overrides })
const offer = (overrides = {}) => ({
  serviceRef: "svc-surface-1",
  courierName: "Synthetic Surface",
  rate: { amountPaise: 6500, currency: "INR" },
  estimatedDeliveryDays: 5,
  quotedAt: NOW.toISOString(),
  mode: "surface",
  maxWeightGrams: 10000,
  maxDeclaredValuePaise: 5000000,
  acceptsRestrictions: [],
  ...overrides,
})
const request = (lines = [line()]) => {
  const built = rates.parcelFor(lines)
  assert.equal(built.ok, true, JSON.stringify(built))
  return rates.rateRequest("560001", { pinCode: "110001", stateCode: "IN-DL" }, built.parcel)
}
const available = options => ({ status: "available", options, quotedAt: NOW.toISOString() })

before(async () => {
  rates = await apiModule("shipping/rates")
})

describe("CHV-S12-M07 the parcel is built from catalogue data, never guessed", () => {
  test("weights add up per unit, value is the goods' price, restrictions come from the products", () => {
    const built = rates.parcelFor([line({ quantity: 2 }), line({ sku: "OUD-50", weightGrams: 350, unitPricePaise: 249900n, restriction: "fragrance_liquid" }), line({ sku: "RING-1", weightGrams: 50, unitPricePaise: 1299900n, restriction: "jewellery_high_value" })])
    assert.deepEqual(built, {
      ok: true,
      parcel: {
        weightGrams: 1200,
        dimensionsMm: null,
        declaredValuePaise: 189900 * 2 + 249900 + 1299900,
        restrictions: ["fragrance_liquid", "jewellery_high_value"],
        items: [{ sku: "KURTA-M", quantity: 2 }, { sku: "OUD-50", quantity: 1 }, { sku: "RING-1", quantity: 1 }],
      },
    })
  })

  test("a line without a weight or a reviewed restriction makes the parcel unsupported: no request, no quote", () => {
    assert.deepEqual(rates.parcelFor([line(), line({ sku: "NOWEIGHT", weightGrams: null }), line({ sku: "UNREVIEWED", restriction: null }), line({ sku: "ZERO", weightGrams: 0 })]), {
      ok: false,
      problems: [
        { sku: "NOWEIGHT", problem: "weight_missing" },
        { sku: "UNREVIEWED", problem: "restriction_unreviewed" },
        { sku: "ZERO", problem: "weight_missing" },
      ],
    })
    assert.equal(rates.parcelFor([]).ok, false)
    assert.equal(rates.parcelFor([line({ quantity: 0 })]).ok, false)
    assert.equal(rates.parcelFor([line({ restriction: "batteries" })]).ok, false, "an unknown restriction is not treated as none")
  })

  test("a malformed pickup or delivery address gives no request", () => {
    const { parcel } = rates.parcelFor([line()])
    assert.equal(rates.rateRequest("056001", { pinCode: "110001", stateCode: "IN-DL" }, parcel), null)
    assert.equal(rates.rateRequest("560001", { pinCode: "11001", stateCode: "IN-DL" }, parcel), null)
    assert.equal(rates.rateRequest("560001", { pinCode: "110001", stateCode: "IN-ZZ" }, parcel), null)
    assert.equal(rates.rateRequest("560001", { pinCode: "110001", stateCode: "in-dl" }, parcel).deliveryStateCode, "IN-DL")
  })
})

describe("CHV-S12-M07 only real offers that fit the parcel survive", () => {
  test("well-formed offers come back exactly as the courier gave them, cheapest first", () => {
    const quote = rates.acceptQuote(request(), available([offer({ serviceRef: "b", rate: { amountPaise: 9000, currency: "INR" } }), offer({ serviceRef: "a" })]), NOW)
    assert.equal(quote.status, "available")
    assert.deepEqual(quote.options.map(o => [o.serviceRef, o.rate.amountPaise]), [["a", 6500], ["b", 9000]])
    assert.deepEqual(quote.options[0], offer({ serviceRef: "a" }))
  })

  test("offers that cannot carry the parcel are dropped; none left is unavailable with no options", () => {
    const heavy = request([line({ weightGrams: 12000 })])
    assert.deepEqual(rates.acceptQuote(heavy, available([offer()]), NOW), { status: "unavailable", reason: "parcel_unsupported", options: [], quotedAt: NOW.toISOString() })
    const valuable = request([line({ unitPricePaise: 6000000n })])
    assert.equal(rates.acceptQuote(valuable, available([offer()]), NOW).status, "unavailable", "goods worth more than the service carries")
    assert.equal(rates.acceptQuote(valuable, available([offer({ maxDeclaredValuePaise: null })]), NOW).status, "available", "a service with no value limit")
  })

  test("a restricted item is never offered a service that does not accept it", () => {
    const perfume = request([line({ sku: "OUD-50", restriction: "fragrance_liquid" })])
    const quote = rates.acceptQuote(perfume, available([offer({ serviceRef: "air", mode: "air" }), offer({ serviceRef: "surface-ok", acceptsRestrictions: ["fragrance_liquid"] })]), NOW)
    assert.deepEqual(quote.options.map(o => o.serviceRef), ["surface-ok"])
    assert.deepEqual(rates.acceptQuote(perfume, available([offer({ mode: "air" }), offer()]), NOW), { status: "unavailable", reason: "category_restricted", options: [], quotedAt: NOW.toISOString() })
    const mixed = request([line({ sku: "OUD-50", restriction: "fragrance_liquid" }), line({ sku: "RING-1", restriction: "jewellery_high_value" })])
    assert.equal(rates.acceptQuote(mixed, available([offer({ acceptsRestrictions: ["fragrance_liquid"] })]), NOW).status, "unavailable", "every restriction must be accepted")
    assert.equal(rates.acceptQuote(mixed, available([offer({ acceptsRestrictions: ["jewellery_high_value", "fragrance_liquid"] })]), NOW).status, "available")
  })

  test("malformed or made-up offers are dropped: wrong currency, fractional or negative paise, missing fields, bad dates", () => {
    const req = request()
    const bad = [
      offer({ rate: { amountPaise: 6500, currency: "USD" } }),
      offer({ rate: { amountPaise: 65.5, currency: "INR" } }),
      offer({ rate: { amountPaise: -1, currency: "INR" } }),
      offer({ rate: { amountPaise: "6500", currency: "INR" } }),
      offer({ rate: null }),
      offer({ serviceRef: "" }),
      offer({ courierName: undefined }),
      offer({ mode: "drone" }),
      offer({ maxWeightGrams: undefined }),
      offer({ acceptsRestrictions: "all" }),
      offer({ quotedAt: "yesterday" }),
      offer({ estimatedDeliveryDays: -2 }),
      null,
      "free shipping",
    ]
    assert.deepEqual(rates.acceptQuote(req, available(bad), NOW), { status: "unavailable", reason: "parcel_unsupported", options: [], quotedAt: NOW.toISOString() })
    assert.deepEqual(rates.acceptQuote(req, available([...bad, offer({ serviceRef: "real" })]), NOW).options.map(o => o.serviceRef), ["real"])
  })

  test("an unavailable answer never carries options, even when the courier attached some", () => {
    const quote = rates.acceptQuote(request(), { status: "unavailable", reason: "pin_unserviceable", options: [offer()] }, NOW)
    assert.deepEqual(quote, { status: "unavailable", reason: "pin_unserviceable", options: [], quotedAt: NOW.toISOString() })
    assert.equal(rates.acceptQuote(request(), { status: "unavailable", reason: "made_up" }, NOW).reason, "provider_unavailable")
    for (const answer of [null, undefined, "ok", 42, { status: "available" }, { status: "available", options: "many" }, { status: "great", options: [offer()] }]) {
      const q = rates.acceptQuote(request(), answer, NOW)
      assert.deepEqual([q.status, q.reason, q.options], ["unavailable", "provider_unavailable", []], JSON.stringify(answer))
    }
  })

  test("returned offers are copies: changing the courier's objects afterwards changes nothing", () => {
    const original = offer()
    const quote = rates.acceptQuote(request(), available([original]), NOW)
    original.rate.amountPaise = 1
    original.acceptsRestrictions.push("fragrance_liquid")
    assert.equal(quote.options[0].rate.amountPaise, 6500)
    assert.deepEqual(quote.options[0].acceptsRestrictions, [])
  })
})

describe("CHV-S12-M07 courier failures give no offer", () => {
  test("a throw, a timeout or a malformed answer is provider_unavailable with no options", async () => {
    const req = request()
    const at = () => NOW
    assert.deepEqual(await rates.quoteParcel({ quoteRates: async () => { throw new Error("courier down") } }, req, { now: at }), { status: "unavailable", reason: "provider_unavailable", options: [], quotedAt: NOW.toISOString() })
    assert.equal((await rates.quoteParcel({ quoteRates: () => new Promise(() => {}) }, req, { timeoutMs: 20, now: at })).reason, "provider_unavailable")
    assert.equal((await rates.quoteParcel({ quoteRates: async () => "nonsense" }, req, { now: at })).reason, "provider_unavailable")
    const good = await rates.quoteParcel({ quoteRates: async r => { assert.deepEqual(r, req, "the courier is asked about exactly this parcel"); return available([offer()]) } }, req, { now: at })
    assert.equal(good.status, "available")
  })
})
