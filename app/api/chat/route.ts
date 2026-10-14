import Anthropic from "@anthropic-ai/sdk"
import { NextResponse, type NextRequest } from "next/server"
import { answer, ChatUnavailableError, isChatConfigured, type ChatTurn } from "@/lib/chat/assistant"

// Shop chat. Request: { messages: [{ role: "user" | "assistant", text }] }, oldest first, ending with
// the customer's new message. Response: { reply, products }. The browser only ever sends plain text;
// tool calls and results stay on the server, so a client cannot inject fake product data.

const MAX_BODY_BYTES = 12 * 1024
const MAX_TURNS = 12
const MAX_USER_CHARS = 500
const MAX_ASSISTANT_CHARS = 2000
const RATE_WINDOW_MS = 10 * 60 * 1000
const RATE_MAX = 20
const hits = new Map<string, { start: number; count: number }>()

const json = (body: object, status: number, headers: Record<string, string> = {}) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } })

// Vercel overwrites x-forwarded-for at the edge, so clients cannot spoof it.
const clientIp = (request: NextRequest) => (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown"

// Best effort, per function instance; set a monthly spend limit in the Anthropic Console as the hard cap.
function retryAfterSeconds(request: NextRequest) {
  const ip = clientIp(request)
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

/** Clean copy of the conversation, or null. Turns alternate, start and end with the customer. */
function parseHistory(value: unknown): ChatTurn[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_TURNS) return null
  const turns: ChatTurn[] = []
  for (const [i, item] of value.entries()) {
    const role = i % 2 === 0 ? "user" : "assistant"
    if (!item || typeof item !== "object" || (item as ChatTurn).role !== role) return null
    const text = (item as ChatTurn).text
    if (typeof text !== "string") return null
    const trimmed = text.trim()
    if (!trimmed || trimmed.length > (role === "user" ? MAX_USER_CHARS : MAX_ASSISTANT_CHARS)) return null
    turns.push({ role, text: trimmed })
  }
  return turns[turns.length - 1].role === "user" ? turns : null
}

export async function POST(request: NextRequest) {
  if (!isOwnSite(request)) return json({ error: "Forbidden" }, 403)
  if (!isChatConfigured()) return json({ error: "Chat isn't available yet. Please reach us on WhatsApp or by email." }, 503)
  const retryAfter = retryAfterSeconds(request)
  if (retryAfter) return json({ error: "You've sent a lot of messages. Please wait a few minutes and try again." }, 429, { "Retry-After": String(retryAfter) })
  if (!(request.headers.get("content-type") || "").toLowerCase().startsWith("application/json")) return json({ error: "Unsupported content type" }, 415)
  if (Number(request.headers.get("content-length") || 0) > MAX_BODY_BYTES) return json({ error: "Message too long" }, 413)

  let history: ChatTurn[] | null
  try {
    const raw = await request.text()
    if (raw.length > MAX_BODY_BYTES) return json({ error: "Message too long" }, 413)
    history = parseHistory(JSON.parse(raw)?.messages)
  } catch {
    history = null
  }
  if (!history) return json({ error: "Invalid request" }, 400)

  try {
    return json(await answer(history, request.nextUrl.origin, clientIp(request)), 200)
  } catch (error) {
    // Status classes only: never log the key, the conversation or the provider's error body.
    if (error instanceof ChatUnavailableError) return json({ error: "Chat isn't available yet. Please reach us on WhatsApp or by email." }, 503)
    if (error instanceof Anthropic.AuthenticationError) console.error("Chat provider rejected the API key")
    else if (error instanceof Anthropic.RateLimitError) return json({ error: "Our assistant is busy right now. Please try again in a minute." }, 503)
    else if (error instanceof Anthropic.APIError) console.error("Chat provider error", error.status)
    else console.error("Chat failed")
    return json({ error: "Our assistant couldn't answer right now. Please try again, or reach us on WhatsApp." }, 502)
  }
}

export function GET() {
  return json({ error: "Method not allowed" }, 405, { Allow: "POST" })
}
