// CHV-S14-M02: sandbox credentials cannot silently call the live gateway. The payment keys are read on the
// server only (apps/api/src/integrations/razorpay/config.ts); test and live never mix, at loading or at any
// later call; live is refused until the legal gate opens (packages/shared/src/config/payments-gate.ts), at
// start-up (packages/shared/src/config/env.ts) as well as in the client. All keys here are fake.
import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { inspect } from "node:util"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { apiModule } from "../auth/helpers.mjs"
import { checkEnv } from "../../../packages/shared/src/config/env.ts"
import { LIVE_PAYMENTS_GATE, livePaymentsApproved } from "../../../packages/shared/src/config/payments-gate.ts"

const ROOT = join(import.meta.dirname, "..", "..", "..")
const { loadRazorpayConfig, razorpayClient, RazorpayConfig, PaymentConfigError, RAZORPAY_API_ORIGIN } = await apiModule("integrations/razorpay/config")

const SECRET = "fake-key-secret-1234567890"
const HOOK = "fake-webhook-secret-0987654321"
const sandbox = { APP_ENV: "staging", PAYMENT_MODE: "test", RAZORPAY_KEY_ID: "rzp_test_FAKE0000000001", RAZORPAY_KEY_SECRET: SECRET, RAZORPAY_WEBHOOK_SECRET: HOOK }
const live = { APP_ENV: "production", PAYMENT_MODE: "live", RAZORPAY_KEY_ID: "rzp_live_FAKE0000000001", RAZORPAY_KEY_SECRET: SECRET, RAZORPAY_WEBHOOK_SECRET: HOOK }
const OPEN_GATE = Object.freeze({ merchantKyc: true, banking: true, tax: true, approvedBy: "Owner (test fixture)", approvedOn: "2026-10-31" })

/** A refusal: a PaymentConfigError naming the setting, with no secret value in it. */
const refused = (setting, problem) => error => {
  assert.ok(error instanceof PaymentConfigError, String(error))
  assert.equal(error.setting, setting)
  if (problem) assert.match(error.message, problem)
  for (const value of [SECRET, HOOK, "rzp_test_FAKE0000000001", "rzp_live_FAKE0000000001"]) assert.ok(!error.message.includes(value), "no value in the message")
  return true
}

/** A recording fetch: what would have gone over the network. */
function recorder() {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, ...init })
    return { status: 200, json: async () => ({}) }
  }
  return { calls, fetchImpl }
}

describe("CHV-S14-M02 keys load on the server, and test and live never mix", () => {
  test("no key configured: payments are off, not an error", () => {
    assert.deepEqual(loadRazorpayConfig({ APP_ENV: "staging" }), { status: "disabled", reason: "no payment key is configured" })
  })

  test("a sandbox configuration loads in development and staging, and its secrets never show", () => {
    for (const APP_ENV of ["development", "staging"]) {
      const loaded = loadRazorpayConfig({ ...sandbox, APP_ENV })
      assert.equal(loaded.status, "ready", APP_ENV)
      assert.deepEqual(JSON.parse(JSON.stringify(loaded.config)), { provider: "razorpay", mode: "test", keyId: "rzp_test_FAKE0000000001" })
      for (const shown of [JSON.stringify(loaded), inspect(loaded, { depth: 5 }), String(loaded.config), Object.keys(loaded.config).join()]) {
        assert.ok(!shown.includes(SECRET) && !shown.includes(HOOK), "secrets stay private")
      }
    }
  })

  test("every mix of test and live is refused at loading", () => {
    assert.throws(() => loadRazorpayConfig({ ...sandbox, RAZORPAY_KEY_ID: "rzp_live_FAKE0000000001" }), refused("RAZORPAY_KEY_ID", /not an rzp_test_ key/))
    assert.throws(() => loadRazorpayConfig({ ...sandbox, SPARE_KEY: "rzp_live_FAKE0000000009" }), refused("SPARE_KEY", /live payment credential/))
    assert.throws(() => loadRazorpayConfig({ ...sandbox, RAZORPAY_KEY_SECRET: "rzp_test_FAKE0000000001" }), refused("RAZORPAY_KEY_SECRET", /key ID/))
    assert.throws(() => loadRazorpayConfig({ ...sandbox, PAYMENT_MODE: "" }), refused("PAYMENT_MODE"))
    assert.throws(() => loadRazorpayConfig({ ...sandbox, PAYMENT_MODE: "sandbox" }), refused("PAYMENT_MODE"))
    assert.throws(() => loadRazorpayConfig({ ...sandbox, RAZORPAY_KEY_SECRET: "" }), refused("RAZORPAY_KEY_SECRET"))
    assert.throws(() => loadRazorpayConfig({ ...sandbox, RAZORPAY_WEBHOOK_SECRET: "" }), refused("RAZORPAY_WEBHOOK_SECRET"))
    assert.throws(() => loadRazorpayConfig({ ...sandbox, RAZORPAY_WEBHOOK_SECRET: SECRET }), refused("RAZORPAY_WEBHOOK_SECRET", /differ/))
    // A live configuration, even with the gate open, may not carry a test key anywhere either.
    assert.throws(() => loadRazorpayConfig({ ...live, RAZORPAY_KEY_ID: "rzp_test_FAKE0000000001" }, { gate: OPEN_GATE }), refused("RAZORPAY_KEY_ID"))
    assert.throws(() => loadRazorpayConfig({ ...live, OLD_KEY: "rzp_test_FAKE0000000002" }, { gate: OPEN_GATE }), refused("OLD_KEY", /test payment credential/))
  })

  test("sandbox stays out of production, and live stays out of development and staging", () => {
    assert.throws(() => loadRazorpayConfig({ ...sandbox, APP_ENV: "production" }), refused("PAYMENT_MODE", /production never runs sandbox/))
    for (const APP_ENV of ["development", "staging"]) assert.throws(() => loadRazorpayConfig({ ...live, APP_ENV }, { gate: OPEN_GATE }), refused("PAYMENT_MODE", /never runs live/), APP_ENV)
  })
})

describe("CHV-S14-M02 live stays shut until the legal gate opens", () => {
  test("the gate is closed today", () => {
    assert.equal(livePaymentsApproved(), false)
    assert.ok(Object.isFrozen(LIVE_PAYMENTS_GATE))
    assert.throws(() => { LIVE_PAYMENTS_GATE.merchantKyc = true }, TypeError)
  })

  test("live keys in production are refused while any part of the gate is missing; the full approval lets them load", () => {
    assert.throws(() => loadRazorpayConfig(live), refused("PAYMENT_MODE", /legal gate/))
    for (const missing of ["merchantKyc", "banking", "tax", "approvedBy", "approvedOn"]) {
      const gate = { ...OPEN_GATE, [missing]: typeof OPEN_GATE[missing] === "boolean" ? false : null }
      assert.equal(livePaymentsApproved(gate), false, missing)
      assert.throws(() => loadRazorpayConfig(live, { gate }), refused("PAYMENT_MODE", /legal gate/), missing)
    }
    assert.equal(livePaymentsApproved({ ...OPEN_GATE, approvedOn: "soon" }), false, "the approval needs a real date")
    const opened = loadRazorpayConfig(live, { gate: OPEN_GATE })
    assert.deepEqual([opened.status, opened.config.mode], ["ready", "live"], "the gate, not anything else, is what blocks live")
  })

  test("the start-up check refuses live settings while the gate is closed", () => {
    const production = checkEnv(live, { target: "production", service: "api" })
    assert.equal(production.ok, false)
    assert.deepEqual(production.errors.filter(e => /legal gate/.test(e.problem)).map(e => e.name).sort(), ["PAYMENT_MODE", "RAZORPAY_KEY_ID"])
    assert.ok(!JSON.stringify(production).includes(SECRET))
    const opened = checkEnv(live, { target: "production", service: "api", liveGate: OPEN_GATE })
    assert.ok(!opened.errors.some(e => /legal gate/.test(e.problem)), "with the approval recorded the gate is satisfied")
  })
})

describe("CHV-S14-M02 the client cannot be pointed at the live gateway with sandbox credentials", () => {
  const ready = () => loadRazorpayConfig(sandbox).config

  test("a sandbox client sends its own test key, to the Razorpay API host only", async () => {
    const { calls, fetchImpl } = recorder()
    const client = razorpayClient(ready(), fetchImpl)
    await client.request("POST", "/v1/orders", { amount: 249900, currency: "INR" })
    assert.equal(calls.length, 1)
    assert.equal(new URL(calls[0].url).origin, RAZORPAY_API_ORIGIN)
    const [keyId, secret] = Buffer.from(calls[0].headers.authorization.replace("Basic ", ""), "base64").toString().split(":")
    assert.deepEqual([keyId, secret], ["rzp_test_FAKE0000000001", SECRET])
    assert.equal(client.mode, "test")
  })

  test("a forged path cannot leave the Razorpay host; nothing is sent", async () => {
    const { calls, fetchImpl } = recorder()
    const client = razorpayClient(ready(), fetchImpl)
    for (const path of ["https://live.example.net/v1/orders", "//evil.example.net/v1/orders", "/v1/../internal", "/v2/orders", "/v1/orders?key=rzp_live_x", "v1/orders"]) {
      await assert.rejects(client.request("GET", path), refused("path"), path)
    }
    assert.equal(calls.length, 0)
  })

  test("a loaded configuration cannot be switched to live or given another key", () => {
    const config = ready()
    assert.ok(Object.isFrozen(config))
    assert.throws(() => { config.mode = "live" }, TypeError)
    assert.throws(() => { config.keyId = "rzp_live_FAKE0000000001" }, TypeError)
    assert.throws(() => Object.defineProperty(config, "mode", { value: "live" }), TypeError)
    assert.equal(config.mode, "test")
  })

  test("a configuration built by hand is checked too: mixed or ungated, it never exists, so no call can be made", () => {
    const closed = LIVE_PAYMENTS_GATE
    assert.throws(() => new RazorpayConfig("test", "rzp_live_FAKE0000000001", SECRET, HOOK, closed), refused("RAZORPAY_KEY_ID"))
    assert.throws(() => new RazorpayConfig("live", "rzp_test_FAKE0000000001", SECRET, HOOK, OPEN_GATE), refused("RAZORPAY_KEY_ID"))
    assert.throws(() => new RazorpayConfig("live", "rzp_live_FAKE0000000001", SECRET, HOOK, closed), refused("PAYMENT_MODE", /legal gate/))
  })

  test("an object posing as a configuration is checked again at the call: nothing is sent", async () => {
    const { calls, fetchImpl } = recorder()
    // Something that copies the shape but swaps in a live key, without the private fields.
    const impostor = Object.create(RazorpayConfig.prototype, { mode: { value: "test" }, keyId: { value: "rzp_live_FAKE0000000001" } })
    await assert.rejects(razorpayClient(impostor, fetchImpl).request("POST", "/v1/orders", {}))
    assert.equal(calls.length, 0)
  })
})

describe("CHV-S14-M02 the web host never holds a payment secret", () => {
  const files = dir => readdirSync(join(ROOT, dir)).flatMap(name => {
    const path = join(dir, name)
    return statSync(join(ROOT, path)).isDirectory() ? files(path) : /\.(ts|tsx|js|mjs)$/.test(name) ? [path] : []
  })

  test("no storefront or admin UI code reads a payment secret or the Razorpay integration", () => {
    for (const path of ["app", "components", "lib"].flatMap(files)) {
      const source = readFileSync(join(ROOT, path), "utf8")
      assert.doesNotMatch(source, /RAZORPAY_KEY_SECRET|RAZORPAY_WEBHOOK_SECRET|integrations\/razorpay/, path)
    }
  })

  test("the start-up check refuses payment secrets on the web host and in browser settings", () => {
    const web = checkEnv({ ...sandbox, NEXT_PUBLIC_RAZORPAY_KEY_SECRET: SECRET }, { target: "staging", service: "web" })
    const flagged = web.errors.map(e => e.name)
    for (const name of ["RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET", "NEXT_PUBLIC_RAZORPAY_KEY_SECRET"]) assert.ok(flagged.includes(name), name)
  })
})
