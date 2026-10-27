"use client"

import Image from "next/image"
import Link from "next/link"
import { ArrowRight, Minus, Plus, ShoppingBag } from "lucide-react"
import * as React from "react"
import { AnimatePresence, motion, useAnimate, useReducedMotion } from "motion/react"
import { EASE, SPRING } from "@/components/motion/motion"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { formatMoney } from "@/lib/types"
import { useCart } from "./cart-provider"
import { ShippingEstimate } from "./shipping-estimate"

export function BagButton() {
  const { count, setOpen } = useCart()
  // The count pops when it changes after the first render, so an added item is noticed. Runs in the
  // browser only, so the server HTML and the first client render match.
  const [badge, animate] = useAnimate()
  const still = useReducedMotion()
  const first = React.useRef(true)
  React.useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    if (!still) animate(badge.current, { scale: [0.6, 1] }, SPRING)
  }, [count, still, animate, badge])
  return (
    <Button variant="ghost" size="icon" className="relative w-11 gap-2 px-0 min-[901px]:w-auto min-[901px]:px-2.5" onClick={() => setOpen(true)} aria-label={`Open bag, ${count} ${count === 1 ? "item" : "items"}`}>
      <ShoppingBag className="size-5" strokeWidth={1.5} aria-hidden />
      <span
        ref={badge}
        className="absolute top-1 right-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-terra px-1 text-[10px] font-semibold tracking-normal text-white min-[901px]:static min-[901px]:h-5 min-[901px]:min-w-5 min-[901px]:px-1.5 min-[901px]:text-[11px]"
        aria-hidden
      >
        {count}
      </span>
    </Button>
  )
}

/** One promo code per bag: a field to apply it, or the applied code with its state and a remove link. */
function PromoCode() {
  const { promotion, applyCode, removeCode, busy } = useCart()
  const [code, setCode] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const errorId = React.useId()

  if (promotion) {
    return (
      <div className="mb-4 flex items-start justify-between gap-3 border-b border-line pb-4 text-sm">
        <div>
          <p>
            Code <strong className="font-semibold tracking-[0.08em]">{promotion.code}</strong> {promotion.applied ? "applied" : "added"}
          </p>
          {!promotion.applied && <p className="mt-1 text-xs text-terra">{promotion.message}</p>}
        </div>
        <Button variant="link" size="sm" className="text-[11px] text-muted-foreground" disabled={busy} onClick={() => removeCode()}>
          Remove
        </Button>
      </div>
    )
  }
  return (
    <form
      className="mb-4 border-b border-line pb-4"
      onSubmit={async event => {
        event.preventDefault()
        if (!code.trim()) return
        const refused = await applyCode(code)
        setError(refused)
        if (!refused) setCode("")
      }}
    >
      <label htmlFor="promo-code" className="text-xs font-semibold tracking-[0.14em] uppercase">
        Promo code
      </label>
      <div className="mt-2 flex gap-2">
        <input
          id="promo-code"
          value={code}
          onChange={event => (setCode(event.target.value), setError(null))}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={32}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className="h-11 min-w-0 flex-1 border border-line-strong bg-paper px-3 text-sm uppercase outline-none transition-colors placeholder:normal-case placeholder:text-muted-foreground focus:border-ink"
          placeholder="Enter a code"
        />
        <Button type="submit" variant="outline" className="h-11" disabled={busy || !code.trim()}>
          Apply
        </Button>
      </div>
      {error && (
        <p id={errorId} role="alert" className="mt-2 text-xs text-terra">
          {error}
        </p>
      )}
    </form>
  )
}

/** `checkoutOpen`: the checkout review page exists here (development and staging, lib/checkout.ts). */
export function CartSheet({ checkoutOpen = false }: { checkoutOpen?: boolean }) {
  const { lines, subtotal, discount, total, promotion, open, setOpen, busy, setQuantity } = useCart()
  const discounted = promotion?.applied && Number(discount.amount) > 0

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
              {/* A removed line slides out and the rest close the gap (transform only). */}
              <AnimatePresence initial={false}>
                {lines.map(line => (
                  <motion.li
                    key={line.id}
                    layout="position"
                    initial={{ opacity: 0, x: 24 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 24, transition: { duration: 0.25, ease: EASE } }}
                    transition={{ duration: 0.4, ease: EASE }}
                    className="grid grid-cols-[88px_1fr] gap-4 border-b border-line py-5"
                  >
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
                      <Button variant="quiet" size="icon" className="size-9" disabled={busy || line.quantity >= 10} onClick={() => setQuantity(line.id, line.quantity + 1)} aria-label={`Increase quantity of ${line.title}`}>
                        <Plus aria-hidden />
                      </Button>
                      <Button variant="link" size="sm" className="ml-auto text-[11px] text-muted-foreground" disabled={busy} onClick={() => setQuantity(line.id, 0)}>
                        Remove
                      </Button>
                    </div>
                  </div>
                  </motion.li>
                ))}
              </AnimatePresence>
            </ul>
          )}
        </div>

        <SheetFooter className="gap-0 border-t border-line bg-card px-6 pt-5 pb-[calc(20px+env(safe-area-inset-bottom))]">
          {lines.length > 0 && open && <ShippingEstimate refreshKey={lines.map(l => `${l.id}:${l.quantity}`).join(",")} />}
          {lines.length > 0 && <PromoCode />}
          <div className="flex justify-between text-base">
            <span>Subtotal</span>
            <strong className="font-semibold">{formatMoney(subtotal)}</strong>
          </div>
          {discounted && (
            <>
              <div className="mt-2 flex justify-between text-sm">
                <span>Discount ({promotion.code})</span>
                <span>
                  <span className="sr-only">minus </span>
                  <span aria-hidden>−</span>
                  {formatMoney(discount)}
                </span>
              </div>
              <div className="mt-2 flex justify-between border-t border-line pt-2 text-base">
                <span>Total</span>
                <strong className="font-semibold">{formatMoney(total)}</strong>
              </div>
            </>
          )}
          <p className="mt-1 text-xs text-muted-foreground">Shipping and taxes are calculated at checkout.</p>
          {checkoutOpen && lines.length > 0 ? (
            // Development and staging: review the order (Stage 12.11). It places no order.
            <Button asChild className="mt-4 h-13 w-full">
              <Link href="/checkout" onClick={() => setOpen(false)}>
                Review order
                <ArrowRight strokeWidth={1.5} aria-hidden />
              </Link>
            </Button>
          ) : (
            /* Production: online checkout is not open until payments exist (Stages 13 and 14). */
            <Button className="mt-4 h-13 w-full" disabled>
              Checkout opens soon
            </Button>
          )}
          <p className="mt-2 text-xs text-muted-foreground">
            Online checkout is being set up. To order now,{" "}
            <Link href="/contact" onClick={() => setOpen(false)} className="underline underline-offset-4 hover:text-terra">
              contact us
            </Link>
            .
          </p>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
