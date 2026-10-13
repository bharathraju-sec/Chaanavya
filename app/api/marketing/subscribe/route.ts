import { NextResponse, type NextRequest } from "next/server"
import { CONSENT_TEXT_VERSION, WELCOME_CAMPAIGN, isLikelyEmail } from "@/lib/marketing/welcome-popup"
import { isNewsletterConfigured, NewsletterError, subscribeEmail } from "@/lib/marketing/newsletter"

// Newsletter signup from the welcome popup. Request: { email, marketingConsent: true, campaign,
// consentTextVersion }. Response is the same for new and existing addresses.

const MAX_BODY_BYTES = 2048
const RATE_WINDOW_MS = 60_000
const RATE_MAX = 5
const hits = new Map<string, { start: number; count: number }>()

const json = (body: object, status: number, headers: Record<string, string> = {}) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } })

// Best effort, per function instance (see docs/SECURITY.md); a platform rate limit is the hard limit.
function retryAfterSeconds(request: NextRequest) {
  const ip = (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown"
  const now = Date.now()
  if (hits.size > 5000) for (const [key, entry] of hits) if (now - entry.start > RATE_WINDOW_MS) hits.delete(key)
  const entry = hits.get(ip)
  if (!entry || now - entry.start > RATE_WINDOW_MS) {
    hits.set(ip, { start: now, count: 1 })
    return 0
  }
  entry.count += 1
  return entry.count > RATE_MAX ? Math.ceil((entry.start + RATE_WINDOW_MS - now) / 1000) : 0
}

function isOwnSite(request: NextRequest) {
  const fetchSite = request.headers.get("sec-fetch-site")
  if (fetchSite) return fetchSite === "same-origin"
  const origin = request.headers.get("origin")
  if (!origin) return false
  try {
    const host = new URL(origin).host
    return host === request.headers.get("host") || host === request.headers.get("x-forwarded-host")
  } catch {
    return false
  }
}

export async function POST(request: NextRequest) {
  if (!isOwnSite(request)) return json({ error: "Forbidden" }, 403)
  const retryAfter = retryAfterSeconds(request)
  if (retryAfter) return json({ error: "Too many attempts. Please wait a minute and try again." }, 429, { "Retry-After": String(retryAfter) })
  if (!(request.headers.get("content-type") || "").toLowerCase().startsWith("application/json")) return json({ error: "Unsupported content type" }, 415)
  if (Number(request.headers.get("content-length") || 0) > MAX_BODY_BYTES) return json({ error: "Request too large" }, 413)

  let body: { email?: unknown; marketingConsent?: unknown; campaign?: unknown; consentTextVersion?: unknown }
  try {
    const raw = await request.text()
    if (raw.length > MAX_BODY_BYTES) return json({ error: "Request too large" }, 413)
    body = JSON.parse(raw)
  } catch {
    return json({ error: "Invalid request" }, 400)
  }

  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : ""
  if (!isLikelyEmail(email)) return json({ error: "Enter a valid email address." }, 400)
  if (body.marketingConsent !== true) return json({ error: "Please tick the box to agree to marketing emails." }, 400)
  if (body.campaign !== WELCOME_CAMPAIGN || body.consentTextVersion !== CONSENT_TEXT_VERSION) return json({ error: "Invalid request" }, 400)

  if (!isNewsletterConfigured()) return json({ error: "Email sign-up isn't available yet. Please try again later." }, 503)

  try {
    await subscribeEmail(email, WELCOME_CAMPAIGN)
    return json({ status: "subscribed" }, 200)
  } catch (error) {
    if (!(error instanceof NewsletterError)) console.error("Newsletter signup failed")
    return json({ error: "We couldn't complete your sign-up right now. Please try again." }, 502)
  }
}

export function GET() {
  return json({ error: "Method not allowed" }, 405, { Allow: "POST" })
}
