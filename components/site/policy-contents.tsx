"use client"

import * as React from "react"
import { motion } from "motion/react"
import { SPRING } from "@/components/motion/motion"
import { cn } from "@/lib/utils"

type Entry = { id: string; title: string }

/**
 * "On this page" for the long policy pages: built from the article's section headings, it stays in
 * view beside the text and a marker slides to the section being read. Wide screens only; on phones
 * the sections read straight through.
 */
export function PolicyContents({ className }: { className?: string }) {
  const [entries, setEntries] = React.useState<Entry[]>([])
  const [active, setActive] = React.useState<string | null>(null)

  React.useEffect(() => {
    const headings = [...document.querySelectorAll<HTMLHeadingElement>("article[data-policy] h2[id]")]
    const frame = requestAnimationFrame(() => setEntries(headings.map(h => ({ id: h.id, title: h.textContent ?? "" }))))
    // The section whose heading most recently crossed the upper third of the screen is the one being read.
    const observer = new IntersectionObserver(
      items => {
        const crossing = items.filter(i => i.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]
        if (crossing) setActive(crossing.target.id)
      },
      { rootMargin: "0px 0px -66% 0px" }
    )
    headings.forEach(h => observer.observe(h))
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [])

  if (entries.length < 3) return null
  return (
    <nav aria-label="On this page" className={cn("hidden lg:block", className)}>
      <div className="sticky top-[140px]">
        <p className="eyebrow mb-4">On this page</p>
        <ol className="border-l border-line">
          {entries.map(entry => (
            <li key={entry.id} className="relative">
              {active === entry.id && <motion.span layoutId="policy-marker" className="absolute top-0 bottom-0 -left-px w-0.5 bg-terra" transition={SPRING} aria-hidden />}
              <a
                href={`#${entry.id}`}
                aria-current={active === entry.id ? "location" : undefined}
                className="block py-2 pl-4 text-[13px] leading-snug text-muted-foreground transition-colors duration-200 hover:text-ink aria-[current=location]:text-ink"
              >
                {entry.title}
              </a>
            </li>
          ))}
        </ol>
      </div>
    </nav>
  )
}
