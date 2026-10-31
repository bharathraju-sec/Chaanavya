// The web host's thin backend-for-frontend (Stage 07, decision 032). The browser keeps calling this
// host's /api/* (same origin, host-only cookies, no CORS); this forwards each request to the NestJS
// API server to server and passes the answer back unchanged. No business rules live here: the API
// decides everything (sign-in, permissions, admin rules, audit).
//
//   /api/auth/*  ->  API /api/auth/*      (Better Auth, same path)
//   /api/<rest>  ->  API /api/v1/<rest>   (versioned API)
//
// It proves to the API that it is the web host (API_INTERNAL_KEY) and tells it what the browser
// sent: the host it used, its IP, Origin / Sec-Fetch-Site, cookies, If-Match and the body. Used by
// app/api/[...path]/route.ts, by server-side page reads (lib/api/server.ts) and by the security
// tests, which run the same code against an in-process API.
//
// Plain Fetch API only, so it can run anywhere Next.js runs and in Node tests.

export type ApiTarget = { url: string; key: string }

export const INTERNAL_KEY_HEADER = "x-chaanavya-internal-key"
/** Matches the API's development fallback (apps/api/src/http/internal-caller.ts); not a secret. */
const DEVELOPMENT_INTERNAL_KEY = "development-only-internal-key-not-a-secret"
const DEVELOPMENT_API_URL = "http://127.0.0.1:4000"
const TIMEOUT_MS = 15_000

/**
 * Browser headers the API needs, passed through as sent. Nothing else crosses (no hop-by-hop or spoofable
 * forwarding headers). The payment provider's webhook signature and event id (Stage 14.09) cross too; the
 * API checks the signature itself, over the body's exact bytes, which are forwarded unchanged.
 */
const PASS_THROUGH = ["accept", "content-type", "cookie", "idempotency-key", "if-match", "origin", "sec-fetch-site", "user-agent", "x-correlation-id", "x-razorpay-signature", "x-razorpay-event-id"]
/** Response headers that describe this hop, not the content. */
const DROP_FROM_RESPONSE = new Set(["connection", "keep-alive", "transfer-encoding", "content-encoding", "content-length", "set-cookie"])

const isDevelopment = (env: Readonly<Record<string, string | undefined>>) =>
  (env.APP_ENV?.trim() || (env.VERCEL_ENV === "production" ? "production" : env.VERCEL_ENV === "preview" ? "staging" : "development")) === "development"

/** Where the API is and the key to call it with. Outside development both must be configured. */
export function apiTarget(env: Readonly<Record<string, string | undefined>> = process.env): ApiTarget {
  const url = env.API_URL?.trim() || (isDevelopment(env) ? DEVELOPMENT_API_URL : "")
  const key = env.API_INTERNAL_KEY?.trim() || (isDevelopment(env) ? DEVELOPMENT_INTERNAL_KEY : "")
  if (!url || !key) throw new Error("API_URL and API_INTERNAL_KEY must be set outside development")
  return { url, key }
}

/** The API path for a path on this host. */
export function upstreamPath(pathname: string) {
  if (pathname === "/api/auth" || pathname.startsWith("/api/auth/")) return pathname
  if (pathname.startsWith("/api/")) return `/api/v1/${pathname.slice("/api/".length)}`
  throw new Error(`not an API path: ${pathname}`)
}

const firstValue = (value: string | null) => value?.split(",")[0]?.trim() || null

/** Forwards a browser request to the API and returns the API's response. 502 when the API cannot be reached. */
export async function forwardToApi(request: Request, target: ApiTarget = apiTarget()): Promise<Response> {
  const url = new URL(request.url)
  const upstream = new URL(`${upstreamPath(url.pathname)}${url.search}`, target.url)
  const headers = new Headers()
  for (const name of PASS_THROUGH) {
    const value = request.headers.get(name)
    if (value !== null) headers.set(name, value)
  }
  headers.set("x-forwarded-host", firstValue(request.headers.get("x-forwarded-host")) ?? request.headers.get("host") ?? url.host)
  headers.set("x-forwarded-proto", firstValue(request.headers.get("x-forwarded-proto")) ?? url.protocol.replace(":", ""))
  const ip = firstValue(request.headers.get("x-forwarded-for")) ?? firstValue(request.headers.get("x-real-ip"))
  if (ip) headers.set("x-forwarded-for", ip)
  headers.set(INTERNAL_KEY_HEADER, target.key)

  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer()
  let response: Response
  try {
    response = await fetch(upstream, { method: request.method, headers, body, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch {
    return Response.json({ error: "api_unavailable" }, { status: 502, headers: { "cache-control": "no-store" } })
  }

  const out = new Headers()
  response.headers.forEach((value, name) => {
    if (!DROP_FROM_RESPONSE.has(name)) out.set(name, value)
  })
  for (const cookie of response.headers.getSetCookie()) out.append("set-cookie", cookie)
  const status = response.status
  return new Response(status === 204 || status === 304 || request.method === "HEAD" ? null : response.body, { status, statusText: response.statusText, headers: out })
}
