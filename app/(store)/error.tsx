"use client"

import { Button } from "@/components/ui/button"
import { ArrowLink } from "@/components/site/editorial"

// Shown when a storefront page fails to render.
export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="page-wrap section-y text-center">
      <p className="eyebrow">Something went wrong</p>
      <h1 className="mt-4 mb-6 text-[clamp(44px,6vw,80px)]">The store is temporarily unavailable.</h1>
      <p className="mx-auto mb-8 max-w-md text-muted-foreground">Please try again in a few minutes.</p>
      <div className="flex flex-wrap items-center justify-center gap-x-7 gap-y-3">
        <Button onClick={reset}>Try again</Button>
        <ArrowLink href="/contact">Contact us</ArrowLink>
      </div>
    </div>
  )
}
