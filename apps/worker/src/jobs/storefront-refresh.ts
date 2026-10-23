// Storefront refresh (Stage 10.10): the outbox handler for `catalogue.updated`. A publish, an
// unpublish, a catalogue edit, a photo change or a stock change expires the web host's cached
// catalogue reads, so shoppers see it within one delivery run (15 seconds) instead of waiting for the
// 60 second cache time. It calls the web host's key-protected refresh route with the same internal key
// the web host uses to reach the API; nothing about the event, and nothing private, is sent.
//
// Delivery is at least once and a failure is retried with growing delays by the outbox job, so a down
// web host only delays freshness (the cache time still bounds how stale a page can be).
import type { Logger } from "@chaanavya/shared/observability/logger"
import type { OutboxHandler } from "./outbox.ts"

export type StorefrontTarget = { url: string; key: string }

export const REFRESH_PATH = "/api/internal/revalidate"
export const REFRESH_TIMEOUT_MS = 5_000
const DEVELOPMENT_WEB_URL = "http://127.0.0.1:3000"

/** Matches the API's and web host's development fallback (apps/api/src/http/internal-caller.ts); not a secret. */
const DEVELOPMENT_INTERNAL_KEY = "development-only-internal-key-not-a-secret"

/**
 * Where the web host is and the key to call it with. Development falls back to the local dev server
 * and key; elsewhere WEB_URL and API_INTERNAL_KEY must be set (null means refresh is not configured).
 */
export function storefrontTarget(env: Readonly<Record<string, string | undefined>>): StorefrontTarget | null {
  const development = (env.APP_ENV?.trim() || "development") === "development"
  const url = env.WEB_URL?.trim() || (development ? DEVELOPMENT_WEB_URL : "")
  const key = env.API_INTERNAL_KEY?.trim() || (development ? DEVELOPMENT_INTERNAL_KEY : "")
  return url && key ? { url: url.replace(/\/$/, ""), key } : null
}

type Delivered = { id: string; createdAt?: Date }

/**
 * One refresh covers every event created before it started, so a burst of stock events (or a batch of
 * 100 delivered in one run) is one request, not one per event.
 */
export function storefrontRefresh(target: StorefrontTarget | null, logger: Logger, send: typeof fetch = fetch): OutboxHandler {
  let coveredUntil = 0
  return async event => {
    const createdAt = (event as Delivered).createdAt?.getTime() ?? Number.POSITIVE_INFINITY
    if (createdAt <= coveredUntil) return
    if (!target) throw new Error("storefront refresh is not configured: set WEB_URL for the worker")
    const startedAt = Date.now()
    const response = await send(`${target.url}${REFRESH_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-chaanavya-internal-key": target.key },
      body: JSON.stringify({ tag: "catalogue" }),
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`storefront refresh answered ${response.status}`)
    coveredUntil = startedAt
    logger.info("outbox.storefront_refreshed", { eventId: event.id })
  }
}
