// Razorpay configuration and the sandbox boundary (Stage 14.02). The only place the payment keys are read:
// on the server, by the API and the worker, never by the web host or the browser. Three rules:
//   - test and live never mix: the mode, the key's prefix and every other setting must agree, or loading
//     fails; a test key can never be used to reach the live gateway, and a live key never runs as test;
//   - live is refused until the legal gate opens (packages/shared/src/config/payments-gate.ts), and test
//     keys are refused in production, so production takes no payments until then;
//   - the client checks the boundary again before every call, so nothing that reaches it later (a changed
//     object, a forged path) can send a request to another mode or another host.
// Secrets live in private fields: they never appear in logs, JSON or error messages.
import { createHmac, timingSafeEqual } from "node:crypto"
import { readEnv, resolveEnvironment, type AppEnvironment, type Env } from "@chaanavya/shared/config/env"
import { LIVE_GATE_CLOSED, LIVE_PAYMENTS_GATE, livePaymentsApproved, type LivePaymentsGate } from "@chaanavya/shared/config/payments-gate"

export type PaymentMode = "test" | "live"

/** Razorpay serves test and live from one host; the key decides the mode, so the key is what we guard. */
export const RAZORPAY_API_ORIGIN = "https://api.razorpay.com"
const KEY_PREFIX: Record<PaymentMode, string> = { test: "rzp_test_", live: "rzp_live_" }

export class PaymentConfigError extends Error {
  readonly setting: string
  constructor(setting: string, problem: string) {
    super(`${setting}: ${problem}`)
    this.name = "PaymentConfigError"
    this.setting = setting
  }
}

export class RazorpayConfig {
  readonly provider = "razorpay" as const
  readonly mode: PaymentMode
  readonly keyId: string
  readonly #keySecret: string
  readonly #webhookSecret: string
  readonly #gate: LivePaymentsGate

  constructor(mode: PaymentMode, keyId: string, keySecret: string, webhookSecret: string, gate: LivePaymentsGate) {
    this.mode = mode
    this.keyId = keyId
    this.#keySecret = keySecret
    this.#webhookSecret = webhookSecret
    this.#gate = gate
    assertBoundary(this)
    Object.freeze(this)
  }

  /** The basic-auth header for one request, checked against the boundary as it is made. */
  authorization() {
    assertBoundary(this)
    return `Basic ${Buffer.from(`${this.keyId}:${this.#keySecret}`).toString("base64")}`
  }

  /**
   * Whether Razorpay signed this checkout return (Stage 14.08): HMAC-SHA256 of "<order id>|<payment id>" with
   * the key secret, compared in constant time. The secret never leaves this object.
   */
  checkoutSignatureMatches(providerOrderId: string, providerPaymentId: string, signature: string) {
    assertBoundary(this)
    const expected = createHmac("sha256", this.#keySecret).update(`${providerOrderId}|${providerPaymentId}`).digest()
    const given = Buffer.from(signature, "hex")
    return given.length === expected.length && timingSafeEqual(given, expected)
  }

  /**
   * Whether Razorpay signed these exact webhook bytes (Stage 14.09): HMAC-SHA256 of the raw body with the
   * webhook secret, compared in constant time. The bytes are checked as received, before anything parses them.
   */
  webhookSignatureMatches(rawBytes: Uint8Array, signature: string) {
    assertBoundary(this)
    const expected = createHmac("sha256", this.#webhookSecret).update(rawBytes).digest()
    const given = Buffer.from(signature, "hex")
    return given.length === expected.length && timingSafeEqual(given, expected)
  }

  /** For verifying webhook signatures (Stage 14.05); never sent anywhere. */
  webhookSecret() {
    return this.#webhookSecret
  }

  liveApproved() {
    return livePaymentsApproved(this.#gate)
  }

  toJSON() {
    return { provider: this.provider, mode: this.mode, keyId: this.keyId }
  }
}

/** The sandbox boundary: the key belongs to the configured mode, and live only behind the legal gate. */
export function assertBoundary(config: RazorpayConfig) {
  if (!config.keyId.startsWith(KEY_PREFIX[config.mode])) throw new PaymentConfigError("RAZORPAY_KEY_ID", `a ${config.mode} configuration must use an ${KEY_PREFIX[config.mode]} key`)
  if (config.mode === "live" && !config.liveApproved()) throw new PaymentConfigError("PAYMENT_MODE", LIVE_GATE_CLOSED)
}

export type LoadedPayments = { status: "disabled"; reason: string } | { status: "ready"; config: RazorpayConfig }

/**
 * Reads the payment settings from the server's environment. No key: payments are off (not an error). A key
 * with anything mixed, missing or not allowed: a PaymentConfigError naming the setting, never its value.
 */
export function loadRazorpayConfig(env: Env, { environment = resolveEnvironment(env), gate = LIVE_PAYMENTS_GATE }: { environment?: AppEnvironment; gate?: LivePaymentsGate } = {}): LoadedPayments {
  const keyId = readEnv(env, "RAZORPAY_KEY_ID")
  if (!keyId) return { status: "disabled", reason: "no payment key is configured" }

  const declared = readEnv(env, "PAYMENT_MODE")
  if (declared !== "test" && declared !== "live") throw new PaymentConfigError("PAYMENT_MODE", "must be test or live when a payment key is set")
  const mode: PaymentMode = declared
  const other: PaymentMode = mode === "test" ? "live" : "test"

  if (mode === "live" && !livePaymentsApproved(gate)) throw new PaymentConfigError("PAYMENT_MODE", LIVE_GATE_CLOSED)
  if (environment === "production" && mode === "test") throw new PaymentConfigError("PAYMENT_MODE", "production never runs sandbox payments")
  if (environment !== "production" && mode === "live") throw new PaymentConfigError("PAYMENT_MODE", `${environment} never runs live payments`)
  if (!keyId.startsWith(KEY_PREFIX[mode])) throw new PaymentConfigError("RAZORPAY_KEY_ID", `PAYMENT_MODE is ${mode} but the key is not an ${KEY_PREFIX[mode]} key`)

  // No other setting may carry the other mode's credential (a live key left in a spare variable, say).
  for (const [name, raw] of Object.entries(env)) {
    if (raw?.includes(KEY_PREFIX[other])) throw new PaymentConfigError(name, `holds a ${other} payment credential while payments are ${mode}`)
  }

  const keySecret = readEnv(env, "RAZORPAY_KEY_SECRET")
  if (!keySecret) throw new PaymentConfigError("RAZORPAY_KEY_SECRET", "required with a payment key")
  if (keySecret.startsWith("rzp_")) throw new PaymentConfigError("RAZORPAY_KEY_SECRET", "holds a key ID, not the key secret")
  const webhookSecret = readEnv(env, "RAZORPAY_WEBHOOK_SECRET")
  if (!webhookSecret) throw new PaymentConfigError("RAZORPAY_WEBHOOK_SECRET", "required with a payment key")
  if (webhookSecret === keySecret) throw new PaymentConfigError("RAZORPAY_WEBHOOK_SECRET", "must differ from the key secret")

  return { status: "ready", config: new RazorpayConfig(mode, keyId, keySecret, webhookSecret, gate) }
}

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; json(): Promise<unknown> }>

/** How long a call to Razorpay may take before its outcome counts as unknown. */
export const RAZORPAY_TIMEOUT_MS = 10_000

/**
 * The only way to call Razorpay. Every request re-checks the boundary, goes to the Razorpay API host only,
 * and carries this configuration's own key; the caller passes a path (and query values), never a URL. A
 * caller with less time left may shorten the timeout, never lengthen it.
 */
export function razorpayClient(config: RazorpayConfig, fetchImpl: Fetch = fetch as unknown as Fetch) {
  return {
    mode: config.mode,
    async request(method: "GET" | "POST", path: string, body?: unknown, { query, timeoutMs = RAZORPAY_TIMEOUT_MS }: { query?: Record<string, string>; timeoutMs?: number } = {}) {
      if (!/^\/v1\/[A-Za-z0-9/_-]+$/.test(path)) throw new PaymentConfigError("path", "must be a Razorpay API path like /v1/orders")
      const url = new URL(path, RAZORPAY_API_ORIGIN)
      if (url.origin !== RAZORPAY_API_ORIGIN) throw new PaymentConfigError("path", "must stay on the Razorpay API host")
      if (query) url.search = new URLSearchParams(query).toString()
      const authorization = config.authorization()
      const timeout = AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, RAZORPAY_TIMEOUT_MS)))
      return fetchImpl(url.toString(), { method, headers: { authorization, "content-type": "application/json" }, signal: timeout, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    },
  }
}
