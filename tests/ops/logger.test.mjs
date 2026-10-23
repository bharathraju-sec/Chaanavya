// Structured logger (packages/shared/src/observability/logger.ts): JSON lines with correlation IDs, and redaction
// of card numbers, CVV, OTPs, tokens, provider signatures, addresses, emails and phone numbers.
// Supports CHV-S03-003 (logs contain no secrets). All values are fake.
import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { correlationIdFrom, createLogger, redact, redactText } from "../../packages/shared/src/observability/logger.ts"

const capture = (options = {}) => {
  const lines = []
  const logger = createLogger({ correlationId: "corr-test-0001", level: "debug", ...options, sink: (level, line) => lines.push({ level, line }) })
  return { logger, lines, records: () => lines.map(l => JSON.parse(l.line)) }
}

const headers = values => ({ get: name => values[name] ?? null })

describe("free-text redaction", () => {
  test("card numbers (PAN) are removed, other long numbers are kept", () => {
    assert.equal(redactText("card 4111 1111 1111 1111 declined"), "card [redacted-pan] declined")
    assert.equal(redactText("card 4111111111111111"), "card [redacted-pan]")
    assert.equal(redactText("card 5500-0000-0000-0004"), "card [redacted-pan]")
    assert.equal(redactText("ref 4111111111111112"), "ref 4111111111111112", "fails the Luhn check, so not a card")
    assert.equal(redactText("order CHV-100001 for 349900 paise"), "order CHV-100001 for 349900 paise")
  })

  test("tokens and provider keys are masked", () => {
    assert.equal(redactText("Authorization: Bearer abc.def.ghi"), "Authorization: Bearer [redacted]")
    assert.equal(redactText("key rzp_live_FAKE1234567890"), "key rzp_live_[redacted]")
    assert.equal(redactText("key rzp_test_FAKE1234567890"), "key rzp_test_[redacted]")
    assert.equal(redactText("sk-ant-api03-FAKEFAKEFAKEFAKEFAKE"), "sk-ant-[redacted]")
  })

  test("emails and Indian mobile numbers are masked", () => {
    assert.equal(redactText("from priya.sharma@example.com"), "from p***@example.com")
    assert.equal(redactText("call +919876543210 or 9876543210"), "call 98******3210 or 98******3210")
    assert.equal(redactText("at 1792014600407 ms"), "at 1792014600407 ms", "timestamps are not phone numbers")
  })
})

describe("structured redaction", () => {
  test("secret keys are dropped at any depth", () => {
    const input = {
      password: "hunter2",
      accessToken: "tok-1",
      razorpay_signature: "sig-1",
      headers: { authorization: "Bearer x", cookie: "session=1", "x-razorpay-signature": "sig" },
      payment: { card: { number: "4111111111111111" }, cvv: "123", otp: "456789", upiPin: "1234" },
      apiKey: "k",
      webhookSecret: "w",
    }
    const out = redact(input)
    assert.equal(out.password, "[redacted]")
    assert.equal(out.accessToken, "[redacted]")
    assert.equal(out.razorpay_signature, "[redacted]")
    assert.deepEqual(out.headers, { authorization: "[redacted]", cookie: "[redacted]", "x-razorpay-signature": "[redacted]" })
    assert.equal(out.payment.card, "[redacted]")
    assert.equal(out.payment.cvv, "[redacted]")
    assert.equal(out.payment.otp, "[redacted]")
    assert.equal(out.payment.upiPin, "[redacted]")
    assert.equal(out.apiKey, "[redacted]")
    assert.equal(out.webhookSecret, "[redacted]")
  })

  test("street address is removed; city, state and PIN code stay for support", () => {
    const out = redact({ shippingAddress: { name: "Synthetic", line1: "12 Example Road", line2: "Flat 4", landmark: "Near park", city: "Bengaluru", stateCode: "IN-KA", pinCode: "560001" } })
    assert.deepEqual(out.shippingAddress, { name: "Synthetic", line1: "[redacted]", line2: "[redacted]", landmark: "[redacted]", city: "Bengaluru", stateCode: "IN-KA", pinCode: "560001" })
  })

  test("email and phone fields are masked, not dropped", () => {
    const out = redact({ email: "priya.sharma@example.com", phone: "+919876543210", whatsappNumber: "9876543210" })
    assert.equal(out.email, "p***@example.com")
    assert.equal(out.phone, "+********3210")
    assert.equal(out.whatsappNumber, "******3210")
  })

  test("errors keep name and redacted message, never the stack", () => {
    const out = redact({ error: new TypeError("charge failed for card 4111111111111111") })
    assert.deepEqual(out.error, { name: "TypeError", message: "charge failed for card [redacted-pan]" })
  })

  test("cycles, arrays and primitives are handled", () => {
    const loop = { id: "o-1" }
    loop.self = loop
    assert.deepEqual(redact(loop), { id: "o-1", self: "[circular]" })
    assert.deepEqual(redact([1, "a@example.com", null, true]), [1, "a***@example.com", null, true])
  })
})

describe("logger", () => {
  test("writes one JSON object per line with time, level, event and correlation ID", () => {
    const { logger, records } = capture()
    logger.info("order.created", { orderId: "o-1", amountPaise: 349900 })
    const [record] = records()
    assert.equal(record.level, "info")
    assert.equal(record.event, "order.created")
    assert.equal(record.correlationId, "corr-test-0001")
    assert.equal(record.orderId, "o-1")
    assert.equal(record.amountPaise, 349900)
    assert.ok(!Number.isNaN(Date.parse(record.time)))
  })

  test("respects the level threshold and routes errors and warnings", () => {
    const { logger, lines } = capture({ level: "warn" })
    logger.debug("hidden")
    logger.info("hidden")
    logger.warn("shown.warn")
    logger.error("shown.error")
    assert.deepEqual(lines.map(l => l.level), ["warn", "error"])
  })

  test("child loggers keep the correlation ID and add fields", () => {
    const { logger, records } = capture()
    logger.child({ module: "payment" }).info("payment.event", { attemptId: "pa-1" })
    const [record] = records()
    assert.equal(record.correlationId, "corr-test-0001")
    assert.equal(record.module, "payment")
    assert.equal(record.attemptId, "pa-1")
  })

  test("nothing sensitive reaches the written line", () => {
    const { logger, lines } = capture()
    const secrets = ["4111111111111111", "hunter2", "rzp_live_FAKE1234567890", "12 Example Road", "priya.sharma@example.com", "9876543210", "sig-abc"]
    logger.error("payment.failed for priya.sharma@example.com", {
      card: "4111111111111111",
      password: "hunter2",
      note: "key rzp_live_FAKE1234567890",
      address: "12 Example Road",
      phone: "9876543210",
      providerSignature: "sig-abc",
      error: new Error("declined 4111 1111 1111 1111"),
    })
    const written = lines.map(l => l.line).join("\n")
    for (const secret of secrets) assert.ok(!written.includes(secret), `leaked: ${secret.slice(0, 4)}...`)
  })
})

describe("correlation IDs", () => {
  test("reuse a well-formed inbound ID, then Vercel's, else create one", () => {
    assert.equal(correlationIdFrom(headers({ "x-correlation-id": "abc12345-req" })), "abc12345-req")
    assert.equal(correlationIdFrom(headers({ "x-vercel-id": "bom1::iad1::abcde-1792014600407-0123456789ab" })), "bom1::iad1::abcde-1792014600407-0123456789ab")
    assert.match(correlationIdFrom(headers({ "x-correlation-id": "bad id with spaces; DROP TABLE" })), /^[0-9a-f-]{36}$/)
    assert.match(correlationIdFrom(), /^[0-9a-f-]{36}$/)
  })

  test("a logger without an ID creates a UUID", () => {
    assert.match(createLogger({ sink: () => {} }).correlationId, /^[0-9a-f-]{36}$/)
  })
})
