"use client"

import { FlaskConical } from "lucide-react"
import * as React from "react"
import type { ShippingRatesV1 } from "@chaanavya/contracts/integrations/courier-gateway"
import { describeShipping, type ShippingDisplay } from "@/lib/shipping-rates"

// Delivery and courier rates for the bag (Stage 12.08), once a delivery address is saved. Test rates
// (sandbox courier, development and staging) are labelled as such on the block and on every price.
// Shows nothing when there is no address, no courier, or the call fails.
export function ShippingEstimate({ refreshKey }: { refreshKey: string }) {
  const [display, setDisplay] = React.useState<ShippingDisplay>({ kind: "hidden" })
  React.useEffect(() => {
    const controller = new AbortController()
    fetch("/api/cart/shipping-rates", { headers: { accept: "application/json" }, cache: "no-store", signal: controller.signal })
      .then(async r => (r.ok ? ((await r.json()) as { data: ShippingRatesV1 }).data : null))
      .then(rates => setDisplay(describeShipping(rates)))
      .catch(() => {
        if (!controller.signal.aborted) setDisplay({ kind: "hidden" })
      })
    return () => controller.abort()
  }, [refreshKey])
  return <ShippingRates display={display} />
}

export function ShippingRates({ display }: { display: ShippingDisplay }) {
  if (display.kind === "hidden") return null
  const test = display.kind === "test"
  return (
    <section aria-label={display.heading} data-rates={display.kind} className={test ? "mb-4 rounded-md border border-dashed border-gold bg-sand px-3 py-3" : "mb-4"}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{display.heading}</h3>
        {display.badge && (
          <span className="inline-flex items-center gap-1 rounded-full border border-gold px-2 py-0.5 text-[11px] font-semibold tracking-wide text-gold-text uppercase">
            <FlaskConical className="size-3" strokeWidth={2} aria-hidden />
            {display.badge}
          </span>
        )}
      </div>
      {display.notice && <p className="mt-1 text-xs text-muted-foreground">{display.notice}</p>}
      <p className="mt-2 text-xs">{display.delivery}</p>
      {display.rows.length > 0 ? (
        <ul className="mt-2 space-y-1.5">
          {display.rows.map(row => (
            <li key={row.key} className="flex items-baseline justify-between gap-3 text-sm">
              <span>
                {row.label}
                {row.detail && <span className="text-muted-foreground"> · {row.detail}</span>}
              </span>
              <span className="shrink-0 tabular-nums">
                {row.testRate && <span className="mr-1.5 text-[11px] font-semibold text-gold-text uppercase">Test rate</span>}
                {row.price}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        display.unavailable && <p className="mt-2 text-xs text-muted-foreground">{display.unavailable}</p>
      )}
    </section>
  )
}
