// Shared helpers for the Stage 05-07 security tests. Each test file runs in its own process with its
// own throwaway database. Since Stage 07 the API is the NestJS application in apps/api (built first by
// `npm run test:security`), started in-process on a random port; every call goes through the web
// host's real forwarding code (lib/api/forward.ts), exactly as a browser request does in production.
// The route names below are the Stage 05/06 route files they replace, so the tests read the same.
import { createHmac, randomBytes } from "node:crypto"
import { appendFileSync } from "node:fs"
import { join } from "node:path"
import { freshDatabase, dropDatabase, orderData } from "../../integration/database/helpers.mjs"

export const ORIGIN = "http://localhost:3000"

/** A module of the built API (apps/api/dist), the same instance the in-process server uses. */
export const apiModule = path => import(new URL(`../../../apps/api/dist/${path}.js`, import.meta.url).href)

/** Configures the environment, migrates a fresh database, starts the API and loads the modules under test. */
export async function setup(name) {
  const { url, client } = freshDatabase(name)
  await client.$disconnect()
  Object.assign(process.env, {
    APP_ENV: "development",
    NODE_ENV: "test",
    DATABASE_URL: url,
    BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
    BETTER_AUTH_URL: ORIGIN,
    API_INTERNAL_KEY: randomBytes(32).toString("base64url"),
    LOG_LEVEL: "error",
  })
  const [{ db }, { auth }, otp, staff, guest, { createApiApp }, { forwardToApi }] = await Promise.all([
    apiModule("db/client"),
    apiModule("auth/server"),
    apiModule("auth/otp-delivery"),
    apiModule("auth/staff"),
    apiModule("auth/guest"),
    apiModule("app"),
    import("@/lib/api/forward"),
  ])
  const app = await createApiApp()
  await app.listen(0, "127.0.0.1")
  const target = { url: `http://127.0.0.1:${app.getHttpServer().address().port}`, key: process.env.API_INTERNAL_KEY }
  return {
    db: db(),
    auth: auth(),
    otp,
    staff,
    guest,
    api: target,
    routes: routesThrough(request => forwardToApi(request, target)),
    async teardown() {
      await app.close()
      await db().$disconnect()
      dropDatabase(name)
    },
  }
}

/** Every former Next.js route now forwards to the API; the forwarder picks the API path from the URL. */
function routesThrough(forward) {
  const handler = { GET: forward, POST: forward, PATCH: forward, PUT: forward, DELETE: forward }
  const names = ["authRoute", "me", "audit", "sessions", "accountOrders", "claim", "order", "staffList", "staffOne", "roles", "roleRevoke", "deactivate", "settings", "session"]
  return Object.fromEntries(names.map(n => [n, handler]))
}

/** Minimal browser cookie jar: keeps name=value pairs, honours deletion. */
export class Jar {
  constructor(extra = {}) {
    this.cookies = new Map(Object.entries(extra))
  }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ")
  }
  absorb(response) {
    for (const line of response.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(";")
      const [name, ...rest] = pair.trim().split("=")
      const value = rest.join("=")
      const expired = attrs.some(a => /^\s*max-age=0\s*$/i.test(a)) || attrs.some(a => /^\s*expires=/i.test(a) && new Date(a.split("=")[1]) < new Date())
      if (expired || value === "") this.cookies.delete(name)
      else this.cookies.set(name, value)
    }
  }
  has(fragment) {
    return [...this.cookies.keys()].some(k => k.includes(fragment))
  }
}

let ipCounter = 0
/** A distinct client IP, so rate-limit counters from one test do not leak into another. */
export const newIp = () => `203.0.113.${(++ipCounter % 250) + 1}`

export function request(path, { method = "GET", body, jar, ip = "198.51.100.1", origin = ORIGIN, headers = {} } = {}) {
  const h = new Headers({ "x-forwarded-for": ip, ...headers })
  if (origin) h.set("origin", origin)
  if (jar?.cookies.size) h.set("cookie", jar.header())
  if (body !== undefined) h.set("content-type", "application/json")
  return new Request(`${ORIGIN}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) })
}

/** Calls a route handler and returns status, parsed JSON and the response. */
export async function call(handler, path, options = {}) {
  const response = await handler(request(path, options), { params: Promise.resolve(options.params ?? {}) })
  options.jar?.absorb(response)
  const text = await response.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = text
  }
  recordForParity(options.method ?? "GET", path, response, json)
  return { status: response.status, json, response }
}

// Old/new contract comparison (Stage 07): with PARITY_RECORD=<dir>, every response is appended,
// normalised (IDs, times, ETags, tokens, codes replaced by placeholders), to <dir>/<test file>.jsonl.
// scripts/parity-diff.mjs compares a run against the Next.js handlers with a run against the API.
const PLACEHOLDERS = [
  [/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "<uuid>"],
  [/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/, "<time>"],
  [/^W\/".+"$/, "<etag>"],
  [/^otpauth:\/\//, "<totp-uri>"],
  [/^\d{6}$/, "<code>"],
  [/^[A-Za-z0-9_-]{20,}$/, "<token>"],
  [/^[A-Za-z0-9]{5}-[A-Za-z0-9]{5}$/, "<backup-code>"],
]
const normalise = value => {
  if (typeof value === "string") return PLACEHOLDERS.find(([pattern]) => pattern.test(value))?.[1] ?? value
  if (Array.isArray(value)) return value.map(normalise)
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, normalise(v)]))
  return value
}
function recordForParity(method, path, response, json) {
  const dir = process.env.PARITY_RECORD
  if (!dir) return
  const file = process.argv[1].split(/[\\/]/).slice(-2).join("_").replace(/\.test\.mjs$/, ".jsonl")
  const route = path.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>").replace(/\?.*$/, "")
  const entry = { method, route, status: response.status, cacheControl: response.headers.get("cache-control"), etag: response.headers.has("etag"), body: normalise(json) }
  appendFileSync(join(dir, file), `${JSON.stringify(entry)}\n`)
}

export const authCall = (ctx, path, options = {}) => call(ctx.routes.authRoute.POST, `/api/auth${path}`, { method: "POST", ...options })

/** Customer sign-in with an emailed code (development outbox). */
export async function signInCustomer(ctx, email, { jar = new Jar(), ip = newIp() } = {}) {
  const sent = await authCall(ctx, "/email-otp/send-verification-otp", { body: { email, type: "sign-in" }, ip })
  if (sent.status !== 200) throw new Error(`send code failed: ${sent.status} ${JSON.stringify(sent.json)}`)
  const otp = ctx.otp.latestDevOtp(email, "sign-in")
  const signedIn = await authCall(ctx, "/sign-in/email-otp", { body: { email, otp }, jar, ip })
  if (signedIn.status !== 200) throw new Error(`sign-in failed: ${signedIn.status} ${JSON.stringify(signedIn.json)}`)
  return jar
}

/** RFC 6238 TOTP (SHA-1, 30 s, 6 digits), the authenticator-app default. Test-side only. */
export function totp(base32Secret, at = Date.now()) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
  let bits = ""
  for (const ch of base32Secret.replace(/=+$/, "").toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, "0")
  const key = Buffer.from(bits.match(/.{8}/g).map(b => parseInt(b, 2)))
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)))
  const hmac = createHmac("sha1", key).update(counter).digest()
  const offset = hmac[hmac.length - 1] & 0xf
  return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0")
}

export const secretFromUri = uri => new URL(uri).searchParams.get("secret")

/** Staff account with a password and a role, created server-side as the owner bootstrap will. */
export async function createStaff(ctx, email, role, password = "correct horse battery staple") {
  const user = await ctx.staff.createStaffUser(ctx.auth, ctx.db, { email, password, role, actor: { kind: "system", process: "test" }, reason: "test fixture", correlationId: `test-${role}` })
  return { user, password }
}

/** Password sign-in, two-factor enrolment and a fresh two-factor sign-in. Returns the TOTP secret and a jar. */
export async function staffWithMfa(ctx, email, role) {
  const { user, password } = await createStaff(ctx, email, role)
  const ip = newIp()
  const setupJar = new Jar()
  await authCall(ctx, "/sign-in/email", { body: { email, password }, jar: setupJar, ip })
  const enabled = await authCall(ctx, "/two-factor/enable", { body: { password }, jar: setupJar, ip })
  if (enabled.status !== 200) throw new Error(`enable 2FA failed: ${enabled.status} ${JSON.stringify(enabled.json)}`)
  const secret = secretFromUri(enabled.json.totpURI)
  const verified = await authCall(ctx, "/two-factor/verify-totp", { body: { code: totp(secret) }, jar: setupJar, ip })
  if (verified.status !== 200) throw new Error(`verify 2FA failed: ${verified.status} ${JSON.stringify(verified.json)}`)
  const jar = await signInStaff(ctx, email, password, secret, { ip: newIp() })
  return { user, password, secret, jar, backupCodes: enabled.json.backupCodes }
}

export async function signInStaff(ctx, email, password, secret, { ip = newIp() } = {}) {
  const jar = new Jar()
  const first = await authCall(ctx, "/sign-in/email", { body: { email, password }, jar, ip })
  if (!first.json?.twoFactorRedirect) throw new Error(`expected a two-factor challenge, got ${first.status} ${JSON.stringify(first.json)}`)
  const second = await authCall(ctx, "/two-factor/verify-totp", { body: { code: totp(secret) }, jar, ip })
  if (second.status !== 200) throw new Error(`two-factor sign-in failed: ${second.status} ${JSON.stringify(second.json)}`)
  return jar
}

export { orderData }

/**
 * Runs `fn(tx)` in a transaction that has declared an origin, as every status change must since Stage
 * 13.08 (apps/api/src/db/origin.ts). For tests that set up or exercise a status directly.
 */
export function withOrigin(db, fn, origin = { actorKind: "system", actorId: null, correlationId: "test-fixture", reason: "test fixture" }) {
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT set_config('chaanavya.origin', ${JSON.stringify(origin)}, true)`
    return fn(tx)
  })
}
