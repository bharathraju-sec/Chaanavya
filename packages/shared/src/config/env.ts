// Server environment contract (Stage 03, split by service in Stage 07). Declares every setting,
// which service reads it (web = Next.js shop and admin UI, api = NestJS API, worker), whether it is
// a secret, when it is required, and the test/live separation rules. `npm run check:env` and CI run it against a
// target environment; reports name settings and problems but never contain values.
//
// Self-contained runtime code (no runtime imports) so Node scripts and tests can load it directly.

export const APP_ENVIRONMENTS = ["development", "staging", "production"] as const
export type AppEnvironment = (typeof APP_ENVIRONMENTS)[number]

/** secret: server only, never logged; public: may reach the browser; config: non-secret setting. */
export type EnvKind = "secret" | "public" | "config"

export type Env = Readonly<Record<string, string | undefined>>

type Context = { environment: AppEnvironment; env: Env }

export const SERVICES = ["web", "api", "worker"] as const
export type Service = (typeof SERVICES)[number]

type Spec = {
  name: string
  kind: EnvKind
  /** Services that read this setting. A setting is checked only for these services. */
  services: readonly Service[]
  required?: (c: Context) => boolean
  /** Returns a problem description, or null when the value is acceptable. Never echoes the value. */
  check?: (value: string, c: Context) => string | null
}

/** Empty strings count as unset, matching how .env.example leaves placeholders blank. */
export const readEnv = (env: Env, name: string) => {
  const value = env[name]?.trim()
  return value ? value : undefined
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "db", "postgres"])
const expectedPaymentMode = (environment: AppEnvironment) => (environment === "production" ? "live" : "test")
/** Staging and production run the database, sign-in and admin; development falls back to local defaults. */
const hosted = (c: Context) => c.environment !== "development"
const production = (c: Context) => c.environment === "production"
const ALL: readonly Service[] = SERVICES
const integerIn = (min: number, max: number) => (v: string) => (/^\d+$/.test(v) && Number(v) >= min && Number(v) <= max ? null : `must be a whole number from ${min} to ${max}`)

export const ENV_SPECS: readonly Spec[] = [
  { name: "APP_ENV", kind: "config", services: ALL, check: v => ((APP_ENVIRONMENTS as readonly string[]).includes(v) ? null : "must be development, staging or production") },
  { name: "NEXT_PUBLIC_GA_MEASUREMENT_ID", kind: "public", services: ["web"], check: v => (/^G-[A-Z0-9]{4,}$/.test(v) ? null : "must look like G-XXXXXXXXXX") },
  // Shop chat (hidden; moves to the API with Stage 18).
  { name: "ANTHROPIC_API_KEY", kind: "secret", services: ["web"] },
  {
    name: "DATABASE_URL",
    kind: "secret",
    services: ["api", "worker"],
    required: hosted,
    check: (v, c) => {
      let url: URL
      try {
        url = new URL(v)
      } catch {
        return "must be a postgresql:// URL"
      }
      if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") return "must be a postgresql:// URL"
      const local = LOCAL_HOSTS.has(url.hostname)
      if (c.environment === "production" && local) return "production cannot use a local database"
      if (c.environment !== "production" && /prod/i.test(`${url.hostname}${url.pathname}`)) return "a non-production environment points at what looks like the production database"
      return null
    },
  },
  {
    name: "PAYMENT_MODE",
    kind: "config",
    services: ["api", "worker"],
    check: (v, c) => {
      if (v !== "test" && v !== "live") return "must be test or live"
      return v === expectedPaymentMode(c.environment) ? null : `${c.environment} must use ${expectedPaymentMode(c.environment)} payments`
    },
  },
  {
    name: "RAZORPAY_KEY_ID",
    kind: "config",
    services: ["api", "worker"],
    check: (v, c) => (v.startsWith(`rzp_${expectedPaymentMode(c.environment)}_`) ? null : `${c.environment} needs an rzp_${expectedPaymentMode(c.environment)}_ key`),
  },
  { name: "RAZORPAY_KEY_SECRET", kind: "secret", services: ["api", "worker"], required: c => Boolean(readEnv(c.env, "RAZORPAY_KEY_ID")), check: v => (v.startsWith("rzp_") ? "holds a key ID, not the key secret" : null) },
  { name: "RAZORPAY_WEBHOOK_SECRET", kind: "secret", services: ["api"], required: c => Boolean(readEnv(c.env, "RAZORPAY_KEY_ID")) },
  { name: "LOG_LEVEL", kind: "config", services: ALL, check: v => (["debug", "info", "warn", "error"].includes(v) ? null : "must be debug, info, warn or error") },
  // Sign-in (Stage 05): signs session cookies and encrypts two-factor secrets.
  { name: "BETTER_AUTH_SECRET", kind: "secret", services: ["api"], required: hosted, check: v => (v.length >= 32 ? null : "must be at least 32 characters (use a random value)") },
  {
    name: "BETTER_AUTH_URL",
    kind: "config",
    services: ["api"],
    required: hosted,
    check: (v, c) => {
      let url: URL
      try {
        url = new URL(v)
      } catch {
        return "must be the site's absolute URL"
      }
      return c.environment === "production" && url.protocol !== "https:" ? "must use https in production" : null
    },
  },
  // Admin workspace on its own host (Stage 06, decision 029), for example https://admin.chaanavya.in.
  {
    name: "ADMIN_URL",
    kind: "config",
    services: ["web", "api"],
    required: production,
    check: (v, c) => {
      let url: URL
      try {
        url = new URL(v)
      } catch {
        return "must be the admin site's absolute URL"
      }
      if (url.pathname !== "/" || url.search) return "must be an origin only, for example https://admin.chaanavya.in"
      if (c.environment === "production" && url.protocol !== "https:") return "must use https in production"
      const site = readEnv(c.env, "BETTER_AUTH_URL")
      try {
        if (site && new URL(site).host === url.host) return "must be a different host from the shop (BETTER_AUTH_URL)"
      } catch {
        /* reported by the BETTER_AUTH_URL check */
      }
      return null
    },
  },
  // Dedicated API (Stage 07, decision 032). The web host calls the API server to server; browsers
  // never call it directly. API_URL is where the web host reaches it, for example https://api.chaanavya.in.
  {
    name: "API_URL",
    kind: "config",
    services: ["web"],
    required: hosted,
    check: (v, c) => {
      let url: URL
      try {
        url = new URL(v)
      } catch {
        return "must be the API's absolute URL"
      }
      if (url.pathname !== "/" || url.search) return "must be an origin only, for example https://api.chaanavya.in"
      return c.environment === "production" && url.protocol !== "https:" ? "must use https in production" : null
    },
  },
  // Shared secret the web host sends with every API call; the API refuses calls without it.
  { name: "API_INTERNAL_KEY", kind: "secret", services: ["web", "api", "worker"], required: hosted, check: v => (v.length >= 32 ? null : "must be at least 32 characters (use a random value)") },
  { name: "API_PORT", kind: "config", services: ["api"], check: integerIn(1, 65535) },
  // Product photo storage (Stage 08, decision 034): any S3-compatible service. Uploads go from the
  // admin browser straight to the bucket with a signed URL; approved photos are copied to public/.
  { name: "MEDIA_S3_BUCKET", kind: "config", services: ["api", "worker"], required: hosted },
  { name: "MEDIA_S3_REGION", kind: "config", services: ["api", "worker"] },
  {
    name: "MEDIA_S3_ENDPOINT",
    kind: "config",
    services: ["api", "worker"],
    check: (v, c) => {
      try {
        const url = new URL(v)
        return c.environment === "production" && url.protocol !== "https:" ? "must be https in production" : null
      } catch {
        return "must be a URL"
      }
    },
  },
  { name: "MEDIA_S3_ACCESS_KEY_ID", kind: "secret", services: ["api", "worker"], required: hosted },
  { name: "MEDIA_S3_SECRET_ACCESS_KEY", kind: "secret", services: ["api", "worker"], required: hosted },
  {
    name: "MEDIA_UPLOAD_ORIGIN",
    kind: "config",
    services: ["web"],
    required: hosted,
    check: (v, c) => {
      try {
        const url = new URL(v)
        if (c.environment === "production" && url.protocol !== "https:") return "must be https in production"
        return url.origin === v.replace(/\/$/, "") ? null : "must be an origin only (scheme, host and port)"
      } catch {
        return "must be a URL"
      }
    },
  },
  {
    name: "MEDIA_PUBLIC_BASE_URL",
    kind: "config",
    services: ["web", "api"],
    required: hosted,
    check: (v, c) => {
      try {
        const url = new URL(v)
        if (c.environment === "production" && url.protocol !== "https:") return "must be https in production"
        return v.endsWith("/") ? null : "must end with /"
      } catch {
        return "must be a URL"
      }
    },
  },
  { name: "DATABASE_POOL_MAX", kind: "config", services: ["api", "worker"], check: integerIn(1, 50) },
  // Where the worker reaches the web host to refresh its cached catalogue pages after a change (Stage
  // 10.10), for example https://chaanavya.in. Without it the shop still refreshes within 60 seconds.
  {
    name: "WEB_URL",
    kind: "config",
    services: ["worker"],
    check: (v, c) => {
      try {
        const url = new URL(v)
        if (c.environment === "production" && url.protocol !== "https:") return "must be https in production"
        return url.origin === v.replace(/\/$/, "") ? null : "must be an origin only (scheme, host and port)"
      } catch {
        return "must be a URL"
      }
    },
  },
  { name: "WORKER_HEALTH_PORT", kind: "config", services: ["worker"], check: integerIn(1, 65535) },
  // TEMPORARY development switch (see auth/two-factor-waiver.ts): "off" lets staff use the admin with a
  // password alone. It is refused anywhere but development; leave it unset to keep two-factor required.
  {
    name: "ADMIN_TWO_FACTOR",
    kind: "config",
    services: ["api"],
    check: (v, c) => (v === "on" ? null : v === "off" ? (c.environment === "development" ? null : "two-factor sign-in cannot be switched off outside development") : "must be on or off"),
  },
]

/** Settings that must never be present on the web host outside development: it holds no database, sign-in or storage secrets. */
const NOT_ON_WEB = ["DATABASE_URL", "BETTER_AUTH_SECRET", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET", "MEDIA_S3_ACCESS_KEY_ID", "MEDIA_S3_SECRET_ACCESS_KEY"]


/** Public names that are safe in the browser even though they look like keys. */
const PUBLIC_ALLOWLIST = new Set(["NEXT_PUBLIC_GA_MEASUREMENT_ID", "NEXT_PUBLIC_RAZORPAY_KEY_ID"])
const SECRET_NAME = /(SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|API_KEY|_KEY$|DATABASE_URL|DSN)/

/** True for declared secrets and for undeclared names that look secret. Used by the secret scanner. */
export function isSecretName(name: string) {
  const spec = ENV_SPECS.find(s => s.name === name)
  if (spec) return spec.kind === "secret"
  return !name.startsWith("NEXT_PUBLIC_") && SECRET_NAME.test(name)
}

export function resolveEnvironment(env: Env, target?: AppEnvironment): AppEnvironment {
  if (target) return target
  const declared = readEnv(env, "APP_ENV")
  if (declared && (APP_ENVIRONMENTS as readonly string[]).includes(declared)) return declared as AppEnvironment
  const vercel = readEnv(env, "VERCEL_ENV")
  if (vercel === "production") return "production"
  if (vercel === "preview") return "staging"
  return "development"
}

export type EnvProblem = { name: string; problem: string }

export type EnvReport = {
  environment: AppEnvironment
  ok: boolean
  errors: EnvProblem[]
  warnings: EnvProblem[]
  settings: { name: string; kind: EnvKind; services: readonly Service[]; required: boolean; status: "set" | "missing" }[]
}

/** Validates an environment without returning or printing any value. Without `service`, every setting is checked. */
export function checkEnv(env: Env, options: { target?: AppEnvironment; service?: Service } = {}): EnvReport {
  const environment = resolveEnvironment(env, options.target)
  const context: Context = { environment, env }
  const errors: EnvProblem[] = []
  const warnings: EnvProblem[] = []

  const declaredEnvironment = readEnv(env, "APP_ENV")
  const vercel = readEnv(env, "VERCEL_ENV")
  if (declaredEnvironment === "production" && vercel && vercel !== "production") errors.push({ name: "APP_ENV", problem: `production is not allowed on a Vercel ${vercel} deployment` })
  if (options.target && declaredEnvironment && declaredEnvironment !== options.target) errors.push({ name: "APP_ENV", problem: `is ${declaredEnvironment} but the check targets ${options.target}` })

  const specs = options.service ? ENV_SPECS.filter(s => s.services.includes(options.service as Service)) : ENV_SPECS
  if (options.service === "web" && environment !== "development") {
    for (const name of NOT_ON_WEB) if (readEnv(env, name)) errors.push({ name, problem: `must not be set on the web host in ${environment}; it belongs to the API` })
  }

  const settings = specs.map(spec => {
    const value = readEnv(env, spec.name)
    const required = spec.required?.(context) ?? false
    if (!value && required) errors.push({ name: spec.name, problem: `required in ${environment}` })
    if (value && spec.check) {
      const problem = spec.check(value, context)
      if (problem) errors.push({ name: spec.name, problem })
    }
    return { name: spec.name, kind: spec.kind, services: spec.services, required, status: value ? ("set" as const) : ("missing" as const) }
  })

  // Test and live credentials never cross: scan every value for the other mode's key prefix.
  const forbiddenPrefix = environment === "production" ? "rzp_test_" : "rzp_live_"
  for (const [name, raw] of Object.entries(env)) {
    if (raw?.includes(forbiddenPrefix)) errors.push({ name, problem: `contains a ${forbiddenPrefix.slice(4, -1)} payment credential, not allowed in ${environment}` })
  }

  // Anything named NEXT_PUBLIC_ is bundled into browser JavaScript.
  const secretValues = new Set(ENV_SPECS.filter(s => s.kind === "secret").map(s => readEnv(env, s.name)).filter(Boolean))
  for (const name of Object.keys(env)) {
    if (!name.startsWith("NEXT_PUBLIC_")) continue
    const bare = name.slice("NEXT_PUBLIC_".length)
    if (!PUBLIC_ALLOWLIST.has(name) && SECRET_NAME.test(bare)) errors.push({ name, problem: "secret-looking setting exposed to the browser through NEXT_PUBLIC_" })
    const value = readEnv(env, name)
    if (value && secretValues.has(value)) errors.push({ name, problem: "holds the same value as a server secret" })
  }

  if (environment === "development") {
    const db = readEnv(env, "DATABASE_URL")
    try {
      if (db && !LOCAL_HOSTS.has(new URL(db).hostname)) warnings.push({ name: "DATABASE_URL", problem: "development is using a remote database; make sure it is a development instance" })
    } catch {
      /* reported by the DATABASE_URL check */
    }
  }
  return { environment, ok: errors.length === 0, errors, warnings, settings }
}
