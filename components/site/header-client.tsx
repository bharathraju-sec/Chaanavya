"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { ArrowRight, Menu, Search } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { cn } from "@/lib/utils"
import { mainNav } from "./nav"

const isActive = (pathname: string, href: string) => pathname === href || pathname.startsWith(`${href}/`)

export function DesktopNav() {
  const pathname = usePathname()
  return (
    <nav aria-label="Main" className="mx-auto hidden max-w-[1440px] justify-center gap-[clamp(20px,3vw,44px)] border-t border-line min-[901px]:flex">
      {mainNav.map(item => (
        <Link
          key={item.href}
          href={item.href}
          aria-current={isActive(pathname, item.href) ? "page" : undefined}
          className="label-caps relative inline-flex min-h-[46px] items-center font-medium after:absolute after:inset-x-0 after:bottom-3 after:h-px after:origin-left after:scale-x-0 after:bg-current after:transition-transform after:duration-300 after:ease-editorial hover:after:scale-x-100 aria-[current=page]:after:scale-x-100"
        >
          {item.label}
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
        <nav aria-label="Main">
          {mainNav.map(item => (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setOpen(false)}
              aria-current={isActive(pathname, item.href) ? "page" : undefined}
              className="flex min-h-[60px] items-center border-b border-line font-serif text-3xl aria-[current=page]:text-terra"
            >
              {item.label}
            </Link>
          ))}
        </nav>
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
