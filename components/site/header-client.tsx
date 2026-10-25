"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { ArrowRight, Menu, Search } from "lucide-react"
import { motion, useMotionValueEvent, useReducedMotion, useScroll } from "motion/react"
import { SPRING } from "@/components/motion/motion"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { cn } from "@/lib/utils"
import { mainNav } from "./nav"

const isActive = (pathname: string, href: string) => pathname === href || pathname.startsWith(`${href}/`)

/**
 * The sticky header slides out of the way while scrolling down the page and returns on any scroll
 * up, near the top, or when keyboard focus moves into it (so focus is never hidden). Transform only.
 */
export function HeaderFrame({ children }: { children: React.ReactNode }) {
  const { scrollY } = useScroll()
  const reduce = useReducedMotion()
  const [hidden, setHidden] = React.useState(false)
  useMotionValueEvent(scrollY, "change", y => {
    const previous = scrollY.getPrevious() ?? 0
    setHidden(was => (reduce || y < 240 ? false : y > previous + 4 ? true : y < previous - 4 ? false : was))
  })
  return (
    <motion.header
      className="sticky top-0 z-40 border-b border-line bg-paper/95 backdrop-blur-sm supports-[not(backdrop-filter:blur(0))]:bg-paper"
      animate={{ y: hidden ? "-100%" : "0%" }}
      transition={{ duration: hidden ? 0.28 : 0.4, ease: [0.22, 1, 0.36, 1] }}
      onFocusCapture={() => setHidden(false)}
    >
      {children}
    </motion.header>
  )
}

export function DesktopNav() {
  const pathname = usePathname()
  const [hovered, setHovered] = React.useState<string | null>(null)
  const current = mainNav.find(item => isActive(pathname, item.href))?.href ?? null
  const marked = hovered ?? current
  return (
    <nav aria-label="Main" className="mx-auto hidden max-w-[1440px] justify-center gap-[clamp(20px,3vw,44px)] border-t border-line min-[901px]:flex" onMouseLeave={() => setHovered(null)}>
      {mainNav.map(item => (
        <Link
          key={item.href}
          href={item.href}
          aria-current={item.href === current ? "page" : undefined}
          onMouseEnter={() => setHovered(item.href)}
          onFocus={() => setHovered(item.href)}
          onBlur={() => setHovered(null)}
          className="label-caps relative inline-flex min-h-[46px] items-center font-medium transition-colors duration-200 hover:text-terra aria-[current=page]:text-terra"
        >
          {item.label}
          {/* One underline glides between items and rests on the current page. */}
          {marked === item.href && <motion.span layoutId="nav-underline" className="absolute inset-x-0 bottom-3 h-px bg-current" transition={SPRING} aria-hidden />}
        </Link>
      ))}
    </nav>
  )
}

export function MobileNav() {
  const pathname = usePathname()
  const [open, setOpen] = React.useState(false)
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="min-[901px]:hidden" aria-label="Open menu">
          <Menu className="size-5" strokeWidth={1.5} aria-hidden />
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="w-full gap-0 bg-paper px-6 pt-16 sm:max-w-sm">
        <SheetTitle className="sr-only">Menu</SheetTitle>
        <SheetDescription className="sr-only">Site navigation</SheetDescription>
        <motion.nav aria-label="Main" initial="hidden" animate={open ? "shown" : "hidden"} variants={{ hidden: {}, shown: { transition: { staggerChildren: 0.05, delayChildren: 0.12 } } }}>
          {mainNav.map(item => (
            <motion.div key={item.href} variants={{ hidden: { opacity: 0, x: -16 }, shown: { opacity: 1, x: 0, transition: { duration: 0.45, ease: [0.22, 1, 0.36, 1] } } }}>
              <Link
                href={item.href}
                onClick={() => setOpen(false)}
                aria-current={isActive(pathname, item.href) ? "page" : undefined}
                className="flex min-h-[60px] items-center justify-between border-b border-line font-serif text-3xl aria-[current=page]:text-terra"
              >
                {item.label}
                <ArrowRight className="size-5 text-muted-foreground" strokeWidth={1.5} aria-hidden />
              </Link>
            </motion.div>
          ))}
        </motion.nav>
      </SheetContent>
    </Sheet>
  )
}

export type SearchEntry = { label: string; href: string }

export function SearchDialog({ products }: { products: SearchEntry[] }) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")
  const entries = React.useMemo(
    () => [
      ...mainNav.filter(i => i.href !== "/contact").map(i => ({ label: i.label, href: i.href })),
      { label: "Track order", href: "/track-order" },
      { label: "Size guide", href: "/size-guide" },
      { label: "Contact", href: "/contact" },
      ...products,
    ],
    [products]
  )
  const q = query.trim().toLowerCase()
  const results = q ? entries.filter(e => e.label.toLowerCase().includes(q)).slice(0, 12) : entries.slice(0, 8)

  return (
    <Dialog open={open} onOpenChange={next => (setOpen(next), next || setQuery(""))}>
      <DialogTrigger asChild>
        <Button variant="ghost" className="h-11 gap-2 px-2.5 label-caps font-medium" aria-label="Search">
          <Search className="size-5" strokeWidth={1.5} aria-hidden />
          <span className="hidden min-[901px]:inline" aria-hidden>
            Search
          </span>
        </Button>
      </DialogTrigger>
      <DialogContent className="top-[12vh] translate-y-0 gap-0 bg-paper p-8 sm:max-w-[560px]">
        <p className="eyebrow">Find your Chaanavya</p>
        <DialogTitle className="font-serif text-4xl font-medium">Search</DialogTitle>
        <DialogDescription className="sr-only">Search collections, help pages and products</DialogDescription>
        <label htmlFor="site-search" className="sr-only">
          Search the store
        </label>
        <input
          id="site-search"
          type="search"
          autoFocus
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Try sarees, gowns or jewellery"
          className="mt-5 h-14 w-full border-0 border-b border-ink bg-transparent px-0.5 text-xl outline-none placeholder:text-muted-foreground"
        />
        <ul className="mt-3 max-h-[50vh] overflow-y-auto">
          {results.length === 0 && <li className="py-4 text-muted-foreground">No matches yet.</li>}
          {results.map(entry => (
            <li key={`${entry.href}-${entry.label}`}>
              <Link
                href={entry.href}
                onClick={() => setOpen(false)}
                className={cn("flex min-h-[52px] items-center justify-between border-b border-line text-[15px] hover:text-terra")}
              >
                {entry.label}
                <ArrowRight className="size-4" strokeWidth={1.5} aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  )
}
