// CHV-S14-M09: invalid signatures and mutated bodies are rejected. POST /api/webhooks/razorpay (the web host's
// forwarder) reaches POST /api/v1/webhooks/razorpay (apps/api/src/modules/webhooks.controller.ts,
// apps/api/src/payments/webhook.ts, the Razorpay adapter's parseWebhook). Nothing is believed until
// Razorpay's signature over the exact bytes received verifies, then the event id, then the event type and its
// entity. Requests are built byte for byte here, signed as Razorpay signs them, with fake secrets.
import { after, before, beforeEach, describe, test } from "node:test"
import assert from "node:assert/strict"
import { createHash, createHmac, randomBytes } from "node:crypto"
import { apiModule, ORIGIN, setup } from "../auth/helpers.mjs"

let ctx, forward, adapter

const SANDBOX = { PAYMENT_MODE: "test", RAZORPAY_KEY_ID: "rzp_test_FAKE0000000019", RAZORPAY_KEY_SECRET: "fake-key-secret-14-09-0001", RAZORPAY_WEBHOOK_SECRET: "fake-webhook-secret-14-09-0001" }
const PATH = "/api/webhooks/razorpay"
const sign = (bytes, secret = SANDBOX.RAZORPAY_WEBHOOK_SECRET) => createHmac("sha256", secret).update(bytes).digest("hex")
const eventId = () => `evt${randomBytes(8).toString("hex")}`

/** A Razorpay webhook body as Razorpay sends it (shape from Razorpay's docs; ids and amounts fake). */
function eventBody(event = "payment.captured", over = {}) {
  const payment = { id: "pay_Fake14090001", entity: "payment", amount: 189900, currency: "INR", status: "captured", order_id: "order_Fake14090001", method: "upi", ...over.payment }
  const payload = { payment: { entity: payment }, ...(event.startsWith("refund.") && { refund: { entity: { id: "rfnd_Fake14090001", entity: "refund", amount: 50000, currency: "INR", payment_id: payment.id, status: "processed", ...over.refund } } }) }
  return { entity: "event", account_id: "acc_Fake14090001", event, contains: Object.keys(payload), payload, created_at: 1793000000, ...over.top }
}
const bytesOf = body => Buffer.from(typeof body === "string" ? body : JSON.stringify(body), "utf8")

/** Razorpay calling the web host: no cookie, no origin, the raw bytes and its two headers. */
async function deliver(bytes, { signature = sign(bytes), id = eventId(), headers = {} } = {}) {
  const h = new Headers({ "content-type": "application/json", "user-agent": "Razorpay-Webhook/v1", "x-forwarded-for": "203.0.113.9", ...headers })
  if (signature !== null) h.set("x-razorpay-signature", signature)
  if (id !== null) h.set("x-razorpay-event-id", id)
  const response = await forward(new Request(`${ORIGIN}${PATH}`, { method: "POST", headers: h, body: bytes }), { params: Promise.resolve({}) })
  const text = await response.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* not json */
  }
  return { status: response.status, json, text, response }
}

const rejected = (res, what) => {
  assert.deepEqual([res.status, res.json?.error?.code, res.json?.error?.message], [400, "invalid_request", "the webhook could not be verified"], what)
}

before(async () => {
  ctx = await setup("chaanavya_test_s14_webhook_signature")
  forward = ctx.routes.me.GET
  Object.assign(process.env, SANDBOX)
  const { loadRazorpayConfig } = await apiModule("integrations/razorpay/config")
  const { razorpayAdapter } = await apiModule("integrations/razorpay/adapter")
  adapter = razorpayAdapter(loadRazorpayConfig({ APP_ENV: "development", ...SANDBOX }).config)
})
after(() => {
  for (const name of Object.keys(SANDBOX)) delete process.env[name]
  return ctx?.teardown()
})
beforeEach(() => Object.assign(process.env, SANDBOX))

describe("CHV-S14-M09 a webhook Razorpay signed over these exact bytes is accepted", () => {
  test("a signed payment.captured event through the web host is acknowledged with its type and id", async () => {
    const bytes = bytesOf(eventBody())
    const id = eventId()
    const res = await deliver(bytes, { id })
    assert.equal(res.status, 200, res.text)
    assert.deepEqual(res.json, { received: true, event: { type: "payment.captured", eventId: id, inbox: "stored" } })
    assert.equal(res.response.headers.get("cache-control"), "no-store")
  })

  test("the bytes are checked as sent, not as re-serialized JSON: odd spacing, key order and non-ASCII text all verify", async () => {
    const text = `{ "created_at":1793000000,\n  "event" : "payment.authorized", "entity":"event",\t"payload":{"payment":{"entity":{"order_id":"order_Fake14090002","currency":"INR","amount":249900,"entity":"payment","id":"pay_Fake14090002","notes":{"gift":"सूती कुर्ता, ₹2,499 — शुभकामनाएँ"}}}}}\n`
    const res = await deliver(bytesOf(text))
    assert.deepEqual([res.status, res.json?.event?.type], [200, "payment.authorized"], res.text)
  })

  test("the signature covers the bytes themselves: a body with bytes that are not valid UTF-8 verifies as sent", async () => {
    // A stray 0xFF inside a note. Decoding to text would turn it into U+FFFD and change the bytes, so a check over
    // the decoded text, rather than the bytes received, would refuse what Razorpay signed.
    const text = JSON.stringify(eventBody("payment.captured", { payment: { notes: { raw: "@@" } } }))
    const [head, tail] = text.split("@@")
    const bytes = Buffer.concat([Buffer.from(head, "utf8"), Buffer.from([0xff]), Buffer.from(tail, "utf8")])
    const res = await deliver(bytes)
    assert.deepEqual([res.status, res.json?.event?.type], [200, "payment.captured"], res.text)
  })

  test("a signed event of a type we do not act on is acknowledged with no event", async () => {
    for (const event of ["order.paid", "payment.dispute.created", "settlement.processed"]) {
      const res = await deliver(bytesOf({ entity: "event", event, payload: {}, created_at: 1793000000 }))
      assert.deepEqual([res.status, res.json], [200, { received: true, event: null }], event)
    }
  })

  test("each event we act on is normalized from the verified bytes: order, payment, refund, amount, fingerprint, time", async () => {
    for (const type of ["payment.authorized", "payment.captured", "payment.failed", "refund.processed", "refund.failed"]) {
      const bytes = bytesOf(eventBody(type))
      const id = eventId()
      const result = await adapter.parseWebhook({ rawBody: bytes.toString("utf8"), rawBytes: bytes, headers: { "x-razorpay-signature": sign(bytes), "x-razorpay-event-id": id } })
      assert.equal(result.valid, true, type)
      const refund = type.startsWith("refund.")
      assert.deepEqual(result.event, {
        provider: "razorpay",
        eventId: id,
        fingerprint: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        type,
        providerOrderId: "order_Fake14090001",
        providerPaymentId: "pay_Fake14090001",
        providerRefundId: refund ? "rfnd_Fake14090001" : null,
        amount: { amountPaise: refund ? 50000 : 189900, currency: "INR" },
        occurredAt: new Date(1793000000 * 1000).toISOString(),
      })
    }
  })
})

describe("CHV-S14-M09 invalid signatures are rejected", () => {
  test("a missing, empty, malformed, wrongly keyed or altered signature is a 400 with one message", async () => {
    const bytes = bytesOf(eventBody())
    const good = sign(bytes)
    const flipAt = (hex, i) => `${hex.slice(0, i)}${hex[i] === "0" ? "1" : "0"}${hex.slice(i + 1)}`
    const cases = [
      ["no signature header", null],
      ["an empty signature", ""],
      ["not hex", "z".repeat(64)],
      ["too short", good.slice(0, 63)],
      ["too long", `${good}0`],
      ["in capitals", good.toUpperCase()],
      ["the first digit changed", flipAt(good, 0)],
      ["the last digit changed", flipAt(good, 63)],
      ["made with the key secret, not the webhook secret", sign(bytes, SANDBOX.RAZORPAY_KEY_SECRET)],
      ["made with a guessed secret", sign(bytes, "webhook-secret")],
      ["base64 instead of hex", createHmac("sha256", SANDBOX.RAZORPAY_WEBHOOK_SECRET).update(bytes).digest("base64")],
      ["two signatures joined", `${good},${good}`],
    ]
    for (const [what, signature] of cases) rejected(await deliver(bytes, { signature }), what)
  })

  test("a correct signature for another event cannot be reused", async () => {
    const first = bytesOf(eventBody())
    const second = bytesOf(eventBody("payment.failed"))
    rejected(await deliver(second, { signature: sign(first) }), "another event's signature")
  })
})

describe("CHV-S14-M09 mutated bodies are rejected", () => {
  test("any change to the signed bytes, however small, is a 400", async () => {
    const text = JSON.stringify(eventBody())
    const signature = sign(bytesOf(text))
    const mutations = [
      ["amount lowered", text.replace('"amount":189900', '"amount":100')],
      ["amount raised", text.replace('"amount":189900', '"amount":1899000')],
      ["another Razorpay order", text.replace("order_Fake14090001", "order_Fake14090009")],
      ["another payment", text.replace("pay_Fake14090001", "pay_Fake14090009")],
      ["captured changed to failed", text.replace('"event":"payment.captured"', '"event":"payment.failed"')],
      ["currency changed", text.replace('"currency":"INR"', '"currency":"USD"')],
      ["a trailing newline", `${text}\n`],
      ["a leading space", ` ${text}`],
      ["re-serialized with spacing", JSON.stringify(JSON.parse(text), null, 2)],
      ["a field added", text.replace('"entity":"event"', '"entity":"event","test":true')],
      ["one byte removed", text.slice(0, -1)],
      ["empty", ""],
    ]
    for (const [what, body] of mutations) rejected(await deliver(bytesOf(body), { signature }), what)
  })

  test("a byte-level change the text cannot show (a different encoding of the same text) is a 400", async () => {
    const text = JSON.stringify(eventBody("payment.captured", { payment: { notes: { gift: "₹" } } }))
    const signature = sign(bytesOf(text))
    rejected(await deliver(Buffer.from(text, "utf16le"), { signature }), "UTF-16 bytes")
    rejected(await deliver(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytesOf(text)]), { signature }), "a byte-order mark added")
  })
})

describe("CHV-S14-M09 the event id and the event itself must hold, even with a valid signature", () => {
  test("a missing or malformed event id is a 400", async () => {
    const bytes = bytesOf(eventBody())
    for (const id of [null, "", "short", "evt with space", `evt${"a".repeat(80)}`]) rejected(await deliver(bytes, { id }), `event id ${JSON.stringify(id)}`)
  })

  test("a signed body that is not a Razorpay event, or an event without the entity its type needs, is a 400", async () => {
    const bad = [
      ["not JSON", "this is not json"],
      ["a JSON array", "[1,2,3]"],
      ["not an event entity", JSON.stringify({ ...eventBody(), entity: "payment" })],
      ["no event name", JSON.stringify({ ...eventBody(), event: undefined })],
      ["an event name in capitals", JSON.stringify(eventBody("Payment.Captured"))],
      ["no created_at", JSON.stringify({ ...eventBody(), created_at: undefined })],
      ["no payload", JSON.stringify({ ...eventBody(), payload: undefined })],
      ["a payment event with no payment", JSON.stringify({ ...eventBody(), payload: {} })],
      ["a payment that is not INR", JSON.stringify(eventBody("payment.captured", { payment: { currency: "USD" } }))],
      ["a zero amount", JSON.stringify(eventBody("payment.captured", { payment: { amount: 0 } }))],
      ["a fractional amount", JSON.stringify(eventBody("payment.captured", { payment: { amount: 1899.5 } }))],
      ["an amount as text", JSON.stringify(eventBody("payment.captured", { payment: { amount: "189900" } }))],
      ["a payment id not Razorpay's", JSON.stringify(eventBody("payment.captured", { payment: { id: "payment-1" } }))],
      ["no Razorpay order", JSON.stringify(eventBody("payment.captured", { payment: { order_id: null } }))],
      ["a refund for another payment", JSON.stringify(eventBody("refund.processed", { refund: { payment_id: "pay_Other0001" } }))],
      ["a refund event with no refund", JSON.stringify({ ...eventBody("refund.processed"), payload: { payment: eventBody().payload.payment } })],
      ["a refund that is not INR", JSON.stringify(eventBody("refund.processed", { refund: { currency: "USD" } }))],
    ]
    for (const [what, text] of bad) rejected(await deliver(bytesOf(text)), what)
  })
})

describe("CHV-S14-M09 only through the web host, only in the sandbox, nothing kept", () => {
  test("a valid event replayed is acknowledged each time and moves nothing (since 14.10 it is kept once in the inbox)", async () => {
    const bytes = bytesOf(eventBody())
    const id = eventId()
    const results = [await deliver(bytes, { id }), ...(await Promise.all(Array.from({ length: 5 }, () => deliver(bytes, { id }))))]
    assert.deepEqual([...new Set(results.map(r => r.status))], [200])
    assert.deepEqual([await ctx.db.providerEvent.count(), await ctx.db.paymentAttempt.count(), await ctx.db.order.count()], [0, 0, 0])
    assert.equal(await ctx.db.paymentWebhookInbox.count({ where: { eventId: id } }), 1)
  })

  test("the API refuses a caller without the web host's key; production has no webhook; payments off is a 503", async () => {
    const bytes = bytesOf(eventBody())
    const direct = await fetch(`${ctx.api.url}/api/v1/webhooks/razorpay`, { method: "POST", headers: { "content-type": "application/json", "x-razorpay-signature": sign(bytes), "x-razorpay-event-id": eventId() }, body: bytes })
    assert.equal(direct.status, 401, "only the web host may call the API")
    const previous = process.env.APP_ENV
    process.env.APP_ENV = "production"
    try {
      assert.equal((await deliver(bytes)).status, 404)
    } finally {
      if (previous === undefined) delete process.env.APP_ENV
      else process.env.APP_ENV = previous
    }
    delete process.env.RAZORPAY_KEY_ID
    assert.equal((await deliver(bytes)).status, 503)
  })

  test("a body over the read limit is a 413, and no answer ever carries a secret or the signature", async () => {
    const huge = bytesOf(JSON.stringify({ ...eventBody(), padding: "x".repeat(70 * 1024) }))
    assert.equal((await deliver(huge)).status, 413)
    const bytes = bytesOf(eventBody())
    const signature = sign(bytes)
    for (const res of [await deliver(bytes, { signature }), await deliver(bytes, { signature: signature.replace(/.$/, "0") })]) {
      for (const secret of [SANDBOX.RAZORPAY_WEBHOOK_SECRET, SANDBOX.RAZORPAY_KEY_SECRET, signature]) assert.ok(!res.text.includes(secret))
    }
  })
})
