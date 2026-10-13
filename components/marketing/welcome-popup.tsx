"use client"

import * as React from "react"
import Image from "next/image"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { LoaderCircle, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import {
  CONSENT_TEXT,
  CONSENT_TEXT_VERSION,
  WELCOME_CAMPAIGN,
  WELCOME_DELAY_MS,
  isEligiblePath,
  isLikelyEmail,
  isSuppressed,
  recordDismissal,
  recordSubscription,
  resetSuppression,
} from "@/lib/marketing/welcome-popup"

type Status = "idle" | "submitting" | "success" | "error"

// At most one automatic opening per page load, across client-side navigations.
let shownThisLoad = false

/** True while another dialog, sheet (cart, menu, search) or the cookie banner is showing. */
const otherOverlayOpen = () => Boolean(document.querySelector('[role="dialog"][data-state="open"], [data-cookie-banner]'))

export function WelcomePopup({ enabled }: { enabled: boolean }) {
  const pathname = usePathname()
  const [open, setOpen] = React.useState(false)
  const [status, setStatus] = React.useState<Status>("idle")
  const [email, setEmail] = React.useState("")
  const [consent, setConsent] = React.useState(false)
  const [fieldError, setFieldError] = React.useState("")
  const [message, setMessage] = React.useState("")

  // Eligibility gate: client-only, after hydration, on browsing pages, once per load.
  React.useEffect(() => {
    if (!enabled || shownThisLoad || !isEligiblePath(pathname)) return
    if (process.env.NODE_ENV === "development" && new URLSearchParams(window.location.search).get("welcome-popup") === "reset") {
      resetSuppression()
    }
    if (isSuppressed()) return

    let timer = window.setTimeout(function attempt() {
      // Never stack on top of the cart, menu, search or another dialog; wait until it closes.
      if (otherOverlayOpen()) {
        timer = window.setTimeout(attempt, 2000)
        return
      }
      if (shownThisLoad || isSuppressed()) return
      shownThisLoad = true
      setOpen(true)
    }, WELCOME_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [enabled, pathname])

  const dismiss = () => {
    if (status !== "success") recordDismissal()
    setOpen(false)
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (status === "submitting") return
    const value = email.trim()
    if (!isLikelyEmail(value)) {
      setFieldError("Enter a valid email address.")
      return
    }
    if (!consent) {
      setFieldError("Please tick the box to agree to marketing emails.")
      return
    }
    setFieldError("")
    setMessage("")
    setStatus("submitting")
    try {
      const response = await fetch("/api/marketing/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: value, marketingConsent: true, campaign: WELCOME_CAMPAIGN, consentTextVersion: CONSENT_TEXT_VERSION }),
      })
      const payload = await response.json().catch(() => ({}))
      if (response.ok && payload.status === "subscribed") {
        recordSubscription()
        setStatus("success")
        setMessage("Thanks for signing up.")
        return
      }
      setStatus("error")
      setMessage(typeof payload.error === "string" ? payload.error : "We couldn't complete your sign-up right now. Please try again.")
    } catch {
      setStatus("error")
      setMessage("We couldn't complete your sign-up right now. Please try again.")
    }
  }

  if (!enabled) return null

  const success = status === "success"

  return (
    <Dialog open={open} onOpenChange={next => (next ? setOpen(true) : dismiss())}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[calc(100dvh-32px)] w-[min(600px,calc(100vw-32px))] max-w-none flex-col gap-0 overflow-hidden bg-card p-0 shadow-[0_24px_60px_rgba(7,63,64,0.18)] ring-0 sm:max-w-[600px] motion-reduce:animate-none"
        onOpenAutoFocus={event => {
          // Focus the email field rather than the first link.
          event.preventDefault()
          document.getElementById("welcome-email")?.focus()
        }}
      >
        <button
          type="button"
          onClick={dismiss}
          aria-label="Close newsletter sign-up"
          className="absolute top-2 right-2 z-10 grid size-11 place-items-center bg-card/90 text-ink transition-colors hover:text-terra"
        >
          <X className="size-6" strokeWidth={1.5} aria-hidden />
        </button>

        {/* Only this area scrolls on short screens, so the close button above stays reachable. */}
        <div className="min-h-0 overflow-y-auto overscroll-contain px-[clamp(20px,6vw,44px)] pt-10 pb-[calc(32px+env(safe-area-inset-bottom))] text-center">
          <div className="mb-6 flex items-center justify-center gap-2.5">
            <Image src="/assets/logo-mark.png" alt="" width={40} height={40} className="size-10 object-contain" />
            <span className="font-serif text-[22px] font-semibold tracking-[0.2em]">CHAANAVYA</span>
          </div>

          <DialogTitle className="font-serif text-[clamp(30px,6vw,42px)] leading-[1.05] font-normal tracking-[0.04em] uppercase">
            {success ? (
              <>
                You&apos;re on
                <br />
                the list
              </>
            ) : (
              <>
                Be first
                <br />
                to know
              </>
            )}
          </DialogTitle>
          <DialogDescription className="mx-auto mt-4 max-w-[420px] text-base leading-relaxed text-muted-foreground">
            {success ? "Thanks for signing up. Keep an eye on your inbox for updates." : "Sign up for updates and the latest arrivals from Chaanavya."}
          </DialogDescription>

          {success ? (
            <Button className="mx-auto mt-8 h-12 w-full max-w-[340px]" onClick={dismiss}>
              Continue shopping
            </Button>
          ) : (
            <form onSubmit={submit} noValidate className="mx-auto mt-7 max-w-[340px] text-left">
              <label htmlFor="welcome-email" className="label-caps mb-2 block text-[11px]">
                Email address
              </label>
              <input
                id="welcome-email"
                name="email"
                type="email"
                inputMode="email"
                autoComplete="email"
                required
                value={email}
                onChange={event => setEmail(event.target.value)}
                placeholder="Email address"
                aria-invalid={Boolean(fieldError) && !isLikelyEmail(email.trim())}
                aria-describedby={fieldError ? "welcome-error" : undefined}
                className="h-12 w-full border border-line-strong bg-paper px-3.5 text-base outline-none transition-colors placeholder:text-muted-foreground focus:border-ink"
              />
              <label className="mt-4 flex min-h-11 cursor-pointer items-start gap-3 text-[13px] leading-snug text-ink">
                <input
                  type="checkbox"
                  name="marketingConsent"
                  checked={consent}
                  onChange={event => setConsent(event.target.checked)}
                  className="mt-0.5 size-5 shrink-0 accent-[#a8461f]"
                />
                <span>{CONSENT_TEXT}</span>
              </label>
              {fieldError && (
                <p id="welcome-error" className="mt-2 text-[13px] text-destructive">
                  {fieldError}
                </p>
              )}
              <Button type="submit" className="mt-5 h-12 w-full" disabled={status === "submitting"}>
                {status === "submitting" ? (
                  <>
                    <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden />
                    Signing up…
                  </>
                ) : (
                  "Sign up"
                )}
              </Button>
              {status === "error" && <p className="mt-3 text-center text-[13px] text-destructive">{message}</p>}
              <div className="mt-4 text-center">
                <button type="button" onClick={dismiss} className="min-h-11 px-2 text-[15px] underline underline-offset-4 transition-colors hover:text-terra">
                  Continue shopping
                </button>
              </div>
            </form>
          )}

          <p className="mx-auto mt-6 max-w-[440px] text-xs leading-relaxed text-muted-foreground">
            We&apos;ll use your email only to send Chaanavya updates, as described in our{" "}
            <Link href="/privacy-policy" onClick={dismiss} className="underline underline-offset-2 hover:text-ink">
              Privacy Policy
            </Link>
            . See also our{" "}
            <Link href="/terms" onClick={dismiss} className="underline underline-offset-2 hover:text-ink">
              Terms &amp; Conditions
            </Link>
            .
          </p>
          <p role="status" aria-live="polite" className="sr-only">
            {status === "submitting" ? "Signing up" : message}
          </p>
        </div>
      </DialogContent>
    </Dialog>
  )
}
