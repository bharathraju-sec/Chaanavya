// Per-request context for the API (Stage 07). Only the web host may call the API (it proves this
// with API_INTERNAL_KEY, src/http/internal-caller.ts), so the headers it forwards are trusted:
//   x-forwarded-host  the host the browser used (shop or admin), for admin-host rules and origin checks
//   x-forwarded-for   the browser's IP, for rate limits
//   origin, sec-fetch-site, cookie, if-match, content-type, user-agent, x-correlation-id  as sent by the browser
import type { Request } from "express"
import type { RawBody } from "../admin/api.ts"
import type { RequestFacts, SignedIn, StaffActor } from "../auth/session.ts"

export type RequestContext = {
  correlationId: string
  host: string
  clientIp: string | null
  body: RawBody
  customer?: SignedIn
  staff?: StaffActor
}

export type ApiRequest = Request & { chaanavya: RequestContext }

/** The request's headers as a Fetch Headers object (Better Auth and the session rules use these). */
export function headersOf(req: Request): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) for (const item of value) headers.append(name, item)
    else headers.set(name, value)
  }
  return headers
}

export const factsOf = (req: ApiRequest): RequestFacts => ({ method: req.method, path: req.path, host: req.chaanavya.host, correlationId: req.chaanavya.correlationId })

/** Query string of the request as URLSearchParams. */
export const queryOf = (req: Request) => new URL(req.originalUrl, "http://api.invalid").searchParams

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)?.split(",")[0]?.trim() || null

export const forwardedHost = (req: Request) => (first(req.headers["x-forwarded-host"]) ?? first(req.headers.host) ?? "").toLowerCase()

export const forwardedClientIp = (req: Request) => first(req.headers["x-forwarded-for"]) ?? req.socket.remoteAddress ?? null
