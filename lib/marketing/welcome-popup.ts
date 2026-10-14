// Welcome (newsletter) popup: configuration and browser-side suppression state.
// Safe to import from client components; holds no secrets.
import { collections } from "@/lib/collections"

export const WELCOME_CAMPAIGN = "welcome-popup-v1"
/** Bump when the consent wording below changes, so stored consent evidence stays traceable. */
export const CONSENT_TEXT_VERSION = "2026-10"
export const CONSENT_TEXT = "Yes, send me Chaanavya marketing emails about new arrivals and updates. I can unsubscribe at any time."

/** Returning visitors: 1 second after the page is interactive (deferred while another overlay shows). */
export const WELCOME_DELAY_MS = 1000
/** First visit: 1 second after the cookie banner is answered, so the two prompts never overlap. */
export const WELCOME_AFTER_CONSENT_MS = 1000
/** How often to re-check while another overlay is open. */
export const WELCOME_RETRY_MS = 250
const DAY_MS = 24 * 60 * 60 * 1000
export const SUBSCRIBE_SUPPRESS_MS = 180 * DAY_MS

const KEYS = {
  subscribed: `chaanavya:welcome-popup:v1:subscribedUntil`,
} as const
/**
 * Closing hides the popup for the rest of this visit, refreshes included (sessionStorage, owner request).
 * Closing the tab ends the visit, so the popup shows again when the site is next opened.
 */
const DISMISSED_THIS_VISIT = "chaanavya:welcome-popup:dismissedThisVisit"
/** Retired dismissal keys (30-day v1, 1-hour v2), cleared so they no longer hide the popup. */
const LEGACY_DISMISSED = ["chaanavya:welcome-popup:v1:dismissedUntil", "chaanavya:welcome-popup:v2:dismissedUntil"]

/** Browsing pages only: never checkout, account, contact, tracking or policy pages. */
const ELIGIBLE = new Set(["/", ...collections.map(c => `/${c.slug}`)])
export const isEligiblePath = (pathname: string) => ELIGIBLE.has(pathname) || /^\/products\/[^/]+$/.test(pathname)

// In-memory fallback when storage is unavailable (private mode, blocked storage).
const memory: Partial<Record<keyof typeof KEYS, number>> = {}
let dismissedInMemory = false

function readUntil(kind: keyof typeof KEYS) {
  try {
    const value = Number(localStorage.getItem(KEYS[kind]))
    return Number.isFinite(value) ? value : 0
  } catch {
    return memory[kind] ?? 0
  }
}

function writeUntil(kind: keyof typeof KEYS, until: number) {
  memory[kind] = until
  try {
    localStorage.setItem(KEYS[kind], String(until))
  } catch {
    /* storage unavailable: the memory fallback covers this page session */
  }
}

function dismissedThisVisit() {
  try {
    for (const key of LEGACY_DISMISSED) localStorage.removeItem(key)
    return sessionStorage.getItem(DISMISSED_THIS_VISIT) === "1"
  } catch {
    return dismissedInMemory
  }
}

export const isSuppressed = (now = Date.now()) => dismissedThisVisit() || readUntil("subscribed") > now

export function recordDismissal() {
  dismissedInMemory = true
  try {
    sessionStorage.setItem(DISMISSED_THIS_VISIT, "1")
  } catch {
    /* storage unavailable: the memory fallback covers this page load */
  }
}
export const recordSubscription = (now = Date.now()) => writeUntil("subscribed", now + SUBSCRIBE_SUPPRESS_MS)

/** Development-only reset (see the ?welcome-popup=reset handling in the component). */
export function resetSuppression() {
  delete memory.subscribed
  dismissedInMemory = false
  try {
    sessionStorage.removeItem(DISMISSED_THIS_VISIT)
    for (const key of LEGACY_DISMISSED) localStorage.removeItem(key)
    localStorage.removeItem(KEYS.subscribed)
  } catch {
    /* ignore */
  }
}

/** Lenient check: one @, no spaces or quotes, a dot in the domain. Plus-addressing and IDN pass. */
export const isLikelyEmail = (value: string) => value.length <= 254 && /^[^\s@"'\\<>]+@[^\s@"'\\<>]+\.[^\s@"'\\<>]+$/.test(value)
