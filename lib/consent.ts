// Cookie consent for non-essential (analytics) cookies, and the Google Analytics loader that
// depends on it. Client-only helpers; holds no secrets (the GA Measurement ID is public).

export type ConsentChoice = "granted" | "denied"

/** Bump the version when the banner wording or the list of trackers changes, so visitors are asked again. */
const CONSENT_VERSION = "v1"
const COOKIE = "chaanavya_consent"
const MAX_AGE_SECONDS = 180 * 24 * 60 * 60

/** Fired on window when the visitor asks to change their choice (footer "Cookie settings"). */
export const OPEN_CONSENT_EVENT = "chaanavya:open-cookie-settings"
/** Fired on window after the stored choice changes. */
export const CONSENT_CHANGE_EVENT = "chaanavya:cookie-consent-changed"

export const isMeasurementId = (id: string | undefined): id is string => Boolean(id && /^G-[A-Z0-9]{4,}$/.test(id))

export function readConsent(): ConsentChoice | null {
  try {
    const match = document.cookie.match(new RegExp(`(?:^|; )${COOKIE}=([^;]*)`))
    const [version, choice] = (match ? decodeURIComponent(match[1]) : "").split(".")
    return version === CONSENT_VERSION && (choice === "granted" || choice === "denied") ? choice : null
  } catch {
    return null
  }
}

export function writeConsent(choice: ConsentChoice) {
  const secure = location.protocol === "https:" ? "; Secure" : ""
  document.cookie = `${COOKIE}=${CONSENT_VERSION}.${choice}; Max-Age=${MAX_AGE_SECONDS}; Path=/; SameSite=Lax${secure}`
  window.dispatchEvent(new Event(CONSENT_CHANGE_EVENT))
}

type Gtag = (...args: unknown[]) => void
declare global {
  interface Window {
    dataLayer?: unknown[]
    gtag?: Gtag
  }
}

/**
 * Loads gtag.js only after consent. The script element is created by our own (nonced) bundle,
 * so the CSP's 'strict-dynamic' allows it without an inline script. GA4 enhanced measurement
 * records client-side navigations from browser history changes.
 */
export function startAnalytics(id: string) {
  ;(window as unknown as Record<string, unknown>)[`ga-disable-${id}`] = false
  if (window.gtag) {
    window.gtag("consent", "update", { analytics_storage: "granted" })
    return
  }
  window.dataLayer = window.dataLayer || []
  window.gtag = function gtag() {
    // gtag.js expects the arguments object itself, not an array.
    // eslint-disable-next-line prefer-rest-params
    window.dataLayer!.push(arguments)
  }
  window.gtag("consent", "default", {
    analytics_storage: "granted",
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
  })
  window.gtag("js", new Date())
  window.gtag("config", id)

  const script = document.createElement("script")
  script.async = true
  script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`
  document.head.appendChild(script)
}

/** Stops collection and removes GA cookies (_ga, _ga_<container>) set on this site. */
export function stopAnalytics(id: string) {
  ;(window as unknown as Record<string, unknown>)[`ga-disable-${id}`] = true
  window.gtag?.("consent", "update", { analytics_storage: "denied" })
  const host = location.hostname
  const domains = ["", host, `.${host}`, `.${host.replace(/^www\./, "")}`]
  for (const name of document.cookie.split("; ").map(c => c.split("=")[0])) {
    if (name !== "_ga" && !name.startsWith("_ga_")) continue
    for (const domain of domains) {
      document.cookie = `${name}=; Max-Age=0; Path=/${domain ? `; Domain=${domain}` : ""}`
    }
  }
}
