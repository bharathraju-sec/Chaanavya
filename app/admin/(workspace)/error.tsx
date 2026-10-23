"use client"

import { Button } from "@/components/ui/button"

// An admin page failed to load. The details are in the server log under the correlation ID.
export default function AdminError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="border border-line bg-card px-6 py-10">
      <p className="eyebrow">Something went wrong</p>
      <h1 className="mt-3 mb-3 text-[32px] text-ink">This page could not load.</h1>
      <p className="mb-6 max-w-xl text-sm text-muted-foreground">Nothing was changed. Try again; if it keeps failing, note the time and tell the owner.</p>
      <Button onClick={reset}>Try again</Button>
    </div>
  )
}
