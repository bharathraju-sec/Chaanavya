"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { useState } from "react"
import { Boxes, ClipboardList, CreditCard, LayoutGrid, Menu, Package, RotateCcw, ScrollText, Settings, Tag, Truck, Users } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import type { AdminSection } from "@/lib/admin/navigation"
import { cn } from "cn"

const ICONS: Record<AdminSection["icon"], typeof LayoutGrid> = {
  overview: LayoutGrid,
  orders: ClipboardList,
  products: Package,
  inventory: Boxes,
  customers: Users,
  shipments: Truck,
  payments: CreditCard,
  returns: RotateCcw,
  promotions: Tag,
  audit: ScrollText,
  settings: Settings,
}

export type NavItem = Pick<AdminSection, "path" | "label" | "icon" | "planned">

function Links({ items, base, onNavigate }: { items: NavItem[]; base: string; onNavigate?: () => void }) {
  const pathname = usePathname()
  return (
    <ul className="flex flex-col">
      {items.map(item => {
        const href = `${base}${item.path}` || "/"
        const active = item.path === "" ? pathname === href : pathname === href || pathname.startsWith(`${href}/`)
        const Icon = ICONS[item.icon]
        return (
          <li key={item.path}>
            <Link
              href={href}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex min-h-11 items-center gap-3 border-l-2 px-5 text-sm transition-colors duration-200",
                active ? "border-terra bg-paper font-semibold text-ink" : "border-transparent text-muted-foreground hover:bg-paper hover:text-ink"
              )}
            >
              <Icon className="size-[18px]" strokeWidth={1.5} aria-hidden />
              <span className="flex-1">{item.label}</span>
              {item.planned && <span className="text-[11px] tracking-[0.08em] text-muted-foreground uppercase">Soon</span>}
            </Link>
          </li>
        )
      })}
    </ul>
  )
}

export function AdminSidebarNav({ items, base }: { items: NavItem[]; base: string }) {
  return (
    <nav aria-label="Admin" className="py-4">
      <Links items={items} base={base} />
    </nav>
  )
}

export function AdminMobileNav({ items, base }: { items: NavItem[]; base: string }) {
  const [open, setOpen] = useState(false)
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open admin menu">
          <Menu className="size-5" strokeWidth={1.5} aria-hidden />
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="w-full gap-0 bg-sand px-0 pt-16 sm:max-w-xs">
        <SheetTitle className="sr-only">Admin menu</SheetTitle>
        <SheetDescription className="sr-only">Admin sections you can open</SheetDescription>
        <nav aria-label="Admin">
          <Links items={items} base={base} onNavigate={() => setOpen(false)} />
        </nav>
      </SheetContent>
    </Sheet>
  )
}
