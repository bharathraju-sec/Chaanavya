"use client"

import Image from "next/image"
import Link from "next/link"
import { ArrowRight, Minus, Plus, ShoppingBag } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { formatMoney } from "@/lib/types"
import { useCart } from "./cart-provider"

export function BagButton() {
  const { count, setOpen } = useCart()
  return (
    <Button variant="ghost" size="icon" className="relative w-auto gap-2 px-2.5" onClick={() => setOpen(true)} aria-label={`Open bag, ${count} ${count === 1 ? "item" : "items"}`}>
      <ShoppingBag className="size-5" strokeWidth={1.5} aria-hidden />
      <span className="grid h-5 min-w-5 place-items-center rounded-full bg-terra px-1.5 text-[11px] font-semibold tracking-normal text-white" aria-hidden>
        {count}
      </span>
    </Button>
  )
}

function safeCheckout(url: string | null) {
  try {
    const parsed = new URL(url ?? "")
    return parsed.protocol === "https:" ? parsed.href : null
  } catch {
    return null
  }
}

export function CartSheet() {
  const { lines, subtotal, checkoutUrl, live, open, setOpen, busy, setQuantity } = useCart()
  const checkout = safeCheckout(checkoutUrl)

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent side="right" className="w-full gap-0 bg-paper p-0 sm:max-w-[460px]">
        <SheetHeader className="border-b border-line px-6 pt-6 pb-5">
          <p className="eyebrow">Your selection</p>
          <SheetTitle className="font-serif text-4xl font-medium">Bag</SheetTitle>
          <SheetDescription className="sr-only">Items in your bag and checkout</SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-6">
          {lines.length === 0 ? (
            <div className="py-16 text-center">
              <p className="mb-5 font-serif text-2xl">Your bag is ready for something new.</p>
              <Button asChild variant="link">
                <Link href="/new-arrivals" onClick={() => setOpen(false)}>
                  Explore new arrivals <ArrowRight aria-hidden />
                </Link>
              </Button>
            </div>
          ) : (
            <ul>
              {lines.map(line => (
                <li key={line.id} className="grid grid-cols-[88px_1fr] gap-4 border-b border-line py-5">
                  <div className="relative h-[110px] w-[88px] bg-well">
                    {line.image && <Image src={line.image} alt="" fill sizes="88px" className="object-cover" />}
                  </div>
                  <div>
                    <Link href={`/products/${line.handle}`} onClick={() => setOpen(false)} className="font-serif text-xl leading-tight hover:underline">
                      {line.title}
                    </Link>
                    {line.option && <p className="mt-1 text-[13px] text-muted-foreground">{line.option}</p>}
                    <p className="mt-1 text-sm font-medium">{formatMoney(line.price)}</p>
                    <div className="mt-3 flex items-center gap-1">
                      <Button variant="quiet" size="icon" className="size-9" disabled={busy} onClick={() => setQuantity(line.id, line.quantity - 1)} aria-label={`Decrease quantity of ${line.title}`}>
                        <Minus aria-hidden />
                      </Button>
                      <span className="min-w-8 text-center text-sm" aria-label="Quantity">
                        {line.quantity}
                      </span>
                      <Button variant="quiet" size="icon" className="size-9" disabled={busy} onClick={() => setQuantity(line.id, line.quantity + 1)} aria-label={`Increase quantity of ${line.title}`}>
                        <Plus aria-hidden />
                      </Button>
                      <Button variant="link" size="sm" className="ml-auto text-[11px] text-muted-foreground" disabled={busy} onClick={() => setQuantity(line.id, 0)}>
                        Remove
                      </Button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <SheetFooter className="gap-0 border-t border-line bg-card px-6 pt-5 pb-[calc(20px+env(safe-area-inset-bottom))]">
          <div className="flex justify-between text-base">
            <span>Subtotal</span>
            <strong className="font-semibold">{formatMoney(subtotal)}</strong>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">Shipping and taxes are calculated at checkout.</p>
          <Button className="mt-4 h-13 w-full" disabled={!checkout || lines.length === 0 || busy} onClick={() => checkout && window.location.assign(checkout)}>
            Secure checkout
          </Button>
          <p className="mt-2 text-xs text-muted-foreground">
            {live ? "Checkout is secured by Shopify." : "Shopify checkout activates when the store connection is configured."}
          </p>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
