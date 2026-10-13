"use client"

import * as React from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { CONSENT_CHANGE_EVENT, OPEN_CONSENT_EVENT, isMeasurementId, readConsent, startAnalytics, stopAnalytics, writeConsent, type ConsentChoice } from "@/lib/consent"

const subscribe = (onChange: () => void) => {
  window.addEventListener(CONSENT_CHANGE_EVENT, onChange)
  return () => window.removeEventListener(CONSENT_CHANGE_EVENT, onChange)
}

/**
 * Non-modal cookie banner. Analytics loads only after "Accept"; "Reject" is equally prominent.
 * The choice is kept in a first-party cookie for 180 days and can be changed from the footer.
 */
export function CookieConsent({ measurementId }: { measurementId?: string }) {
  const gaId = isMeasurementId(measurementId) ? measurementId : undefined
  // "pending" during server render and hydration, so the banner never flashes for returning visitors.
  const choice = React.useSyncExternalStore(subscribe, readConsent, () => "pending" as const)
  const [reopened, setReopened] = React.useState(false)
  const headingRef = React.useRef<HTMLHeadingElement>(null)

  React.useEffect(() => {
    if (choice === "granted" && gaId) startAnalytics(gaId)
  }, [choice, gaId])

  React.useEffect(() => {
    const reopen = () => {
      setReopened(true)
      // Opened on request, so move focus to it; on first visit it never steals focus.
      requestAnimationFrame(() => headingRef.current?.focus())
    }
    window.addEventListener(OPEN_CONSENT_EVENT, reopen)
    return () => window.removeEventListener(OPEN_CONSENT_EVENT, reopen)
  }, [])

  function choose(choice: ConsentChoice) {
    if (gaId && choice === "denied") stopAnalytics(gaId)
    writeConsent(choice)
    setReopened(false)
  }

  if (choice !== null && !reopened) return null

  return (
    <section
      data-cookie-banner
      aria-labelledby="cookie-consent-title"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-line-strong bg-card shadow-[0_-12px_40px_rgba(7,63,64,0.12)] motion-safe:animate-in motion-safe:slide-in-from-bottom-4 motion-safe:fade-in-0"
    >
      <div className="page-wrap flex flex-col gap-3 py-4 pb-[calc(16px+env(safe-area-inset-bottom))] md:py-5 md:flex-row md:items-center md:gap-8">
        <div className="min-w-0 flex-1">
          <h2 id="cookie-consent-title" ref={headingRef} tabIndex={-1} className="font-serif text-xl leading-tight outline-none">
            Cookies on Chaanavya
          </h2>
          <p className="mt-1 max-w-[720px] text-[13px] leading-normal md:text-sm md:leading-relaxed text-muted-foreground">
            We use essential storage to run the site. With your permission we&apos;d also use Google Analytics cookies to see how the site is
            used. Change this any time under Cookie settings in the footer.{" "}
            <Link href="/privacy-policy" className="text-ink underline underline-offset-2 hover:text-terra">
              Privacy Policy
            </Link>
          </p>
        </div>
        <div className="grid shrink-0 grid-cols-2 gap-3 md:flex">
          <Button variant="outline" className="h-11 md:min-w-[140px]" onClick={() => choose("denied")}>
            Reject
          </Button>
          <Button variant="outline" className="h-11 md:min-w-[140px]" onClick={() => choose("granted")}>
            Accept
          </Button>
        </div>
      </div>
    </section>
  )
}

/** Footer link that reopens the banner. */
export function CookieSettingsButton({ className }: { className?: string }) {
  return (
    <button type="button" className={className} onClick={() => window.dispatchEvent(new Event(OPEN_CONSENT_EVENT))}>
      Cookie settings
    </button>
  )
}
