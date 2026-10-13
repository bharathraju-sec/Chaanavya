"use client"

import * as React from "react"
import { Button } from "@/components/ui/button"

// No email service is connected yet, so this only validates. Wire it to the
// newsletter provider before launch.
export function NewsletterForm() {
  const [message, setMessage] = React.useState("New drops, styling notes and invites to private trunk shows.")
  return (
    <>
      <form
        className="mx-auto mt-10 mb-4 flex max-w-[560px] gap-3 max-sm:flex-col"
        onSubmit={e => {
          e.preventDefault()
          setMessage("Thanks, your details are ready.")
        }}
      >
        <label htmlFor="newsletter-email" className="sr-only">
          Email address
        </label>
        <input
          id="newsletter-email"
          type="email"
          required
          autoComplete="email"
          placeholder="Enter your email address"
          className="h-13 min-w-0 flex-1 border border-line-strong bg-card px-4 text-base outline-none transition-colors focus:border-ink"
        />
        <Button type="submit" className="h-13">
          Join the circle
        </Button>
      </form>
      <p role="status" aria-live="polite" className="text-[13px] text-muted-foreground">
        {message}
      </p>
    </>
  )
}
