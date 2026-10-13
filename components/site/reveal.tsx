"use client"

import * as React from "react"
import { cn } from "@/lib/utils"

// Fades a section in as it scrolls into view. Content is visible in the server HTML;
// only sections that start below the fold are hidden, and never under reduced motion.
export function Reveal({ as: Tag = "section", className, children, ...props }: React.HTMLAttributes<HTMLElement> & { as?: "section" | "div" }) {
  const ref = React.useRef<HTMLElement>(null)
  const [state, setState] = React.useState<"idle" | "pending" | "done">("idle")

  React.useEffect(() => {
    const el = ref.current
    if (!el || !("IntersectionObserver" in window) || matchMedia("(prefers-reduced-motion: reduce)").matches) return
    if (el.getBoundingClientRect().top < window.innerHeight) return
    setState("pending")
    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(e => e.isIntersecting)) {
          setState("done")
          observer.disconnect()
        }
      },
      { rootMargin: "0px 0px -8% 0px" }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return (
    <Tag ref={ref as React.Ref<HTMLDivElement>} className={cn(state === "pending" && "reveal-pending", state === "done" && "reveal-done", className)} {...props}>
      {children}
    </Tag>
  )
}
