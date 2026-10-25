"use client"

// Shared Motion pieces for the storefront (2026 redesign, approved 25 October 2026).
// One rhythm for the whole shop: arrivals decelerate on EASE, springs for presses and indicators.
// Everything animates transform, opacity or clip only, so nothing shifts the layout. Under
// prefers-reduced-motion every piece renders its final state at once: no fade, wipe or drift.
// Content at the top of a page (Enter, MaskLines, Stagger immediate) animates with CSS keyframes
// from app/globals.css, so it shows on first paint instead of waiting for JavaScript.
import * as React from "react"
import { motion, MotionConfig, useReducedMotion, useScroll, useTransform, type Variants } from "motion/react"
import { cn } from "@/lib/utils"

export const EASE = [0.22, 1, 0.36, 1] as const
export const SPRING = { type: "spring", stiffness: 380, damping: 32, mass: 0.8 } as const

/** Store-wide motion settings: honours the visitor's reduced-motion choice. */
export function StoreMotion({ children }: { children: React.ReactNode }) {
  return (
    <MotionConfig reducedMotion="user" transition={{ duration: 0.6, ease: EASE }}>
      {children}
    </MotionConfig>
  )
}

/** The variant a piece starts from: its final state when the visitor prefers reduced motion. */
const useStart = () => (useReducedMotion() ? "shown" : "hidden")

const rise: Variants = {
  hidden: { opacity: 0, y: 22 },
  shown: { opacity: 1, y: 0, transition: { duration: 0.7, ease: EASE } },
}

/** Rises into place the first time it scrolls into view. */
export function Rise({ as = "div", className, children, delay = 0, id }: { as?: "div" | "section" | "li"; className?: string; children: React.ReactNode; delay?: number; id?: string }) {
  const Tag = motion[as]
  return (
    <Tag id={id} className={className} variants={rise} initial={useStart()} whileInView="shown" viewport={{ once: true, amount: 0.15 }} transition={{ delay }}>
      {children}
    </Tag>
  )
}

const group: Variants = { hidden: {}, shown: { transition: { staggerChildren: 0.07, delayChildren: 0.05 } } }

/**
 * A group whose StaggerItem children arrive one after another (about 70ms apart): as they scroll
 * into view, or on first paint with `immediate` (CSS, so it does not wait for JavaScript).
 */
export function Stagger({ className, children, immediate }: { className?: string; children: React.ReactNode; immediate?: boolean }) {
  const start = useStart()
  if (immediate) return <div className={cn("chv-stagger", className)}>{children}</div>
  return (
    <motion.div className={className} variants={group} initial={start} whileInView="shown" viewport={{ once: true, amount: 0.1 }}>
      {children}
    </motion.div>
  )
}

export function StaggerItem({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <motion.div className={className} variants={rise}>
      {children}
    </motion.div>
  )
}

/** A display heading whose lines rise out of a mask, line by line, on first paint (CSS). */
export function MaskLines({ lines, className, as: Tag = "h1", delay = 0.1 }: { lines: string[]; className?: string; as?: "h1" | "h2"; delay?: number }) {
  return (
    <Tag className={className}>
      {lines.map((line, i) => (
        <span key={line} className="block overflow-hidden pb-[0.06em]">
          <span className="chv-line block" style={{ "--d": `${delay + i * 0.12}s` } as React.CSSProperties}>
            {line}
          </span>
        </span>
      ))}
    </Tag>
  )
}

/** Uncovers an image with a wipe from the bottom edge when it scrolls into view. */
export function ImageReveal({ className, children }: { className?: string; children: React.ReactNode }) {
  const still = useReducedMotion()
  return (
    <motion.div
      className={cn("relative overflow-hidden", className)}
      initial={still ? false : { clipPath: "inset(18% 0% 0% 0%)", opacity: 0.4 }}
      whileInView={{ clipPath: "inset(0% 0% 0% 0%)", opacity: 1 }}
      viewport={{ once: true, amount: 0.25 }}
      transition={{ duration: 1.1, ease: EASE }}
    >
      {children}
    </motion.div>
  )
}

/**
 * The hero photo settles from a slight zoom on load and drifts a little slower than the page while
 * scrolling. It is never hidden (it is the largest paint), and it holds still under reduced motion.
 */
export function HeroImage({ className, children }: { className?: string; children: React.ReactNode }) {
  const ref = React.useRef<HTMLDivElement>(null)
  const still = useReducedMotion()
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end start"] })
  const y = useTransform(scrollYProgress, [0, 1], ["0%", still ? "0%" : "8%"])
  return (
    <div ref={ref} className={cn("relative overflow-hidden", className)}>
      <motion.div className="absolute inset-[-4%_0]" style={{ y }} initial={still ? false : { scale: 1.06 }} animate={{ scale: 1 }} transition={{ duration: 1.6, ease: EASE }}>
        {children}
      </motion.div>
    </div>
  )
}

/** Fades and lifts in on first paint (CSS), for content near the top of a page. */
export function Enter({ className, children, delay = 0 }: { className?: string; children: React.ReactNode; delay?: number }) {
  return (
    <div className={cn("chv-enter", className)} style={delay ? ({ "--d": `${delay}s` } as React.CSSProperties) : undefined}>
      {children}
    </div>
  )
}
