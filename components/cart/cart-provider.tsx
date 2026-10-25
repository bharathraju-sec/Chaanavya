"use client"

import * as React from "react"
import { toast } from "sonner"
import type { CartLine, Money, Product, Variant } from "@/lib/types"
import { optionLabel } from "@/lib/types"

// The bag is kept by the shop's API (Stage 11.02): /api/cart, forwarded to NestJS. This only shows it.
// A guest's bag follows an HttpOnly cookie the API sets on the first add, so it survives a reload
// and is never readable by page scripts. Prices, titles and photos always come from the API's
// catalogue; the browser sends only which variant and how many. Nothing is reserved or charged.

type ApiMoney = { amountPaise: number; currency: string }
type ApiCart = {
  lines: { id: string; quantity: number; title: string; variantTitle: string; handle: string; imageUrl: string | null; unitPrice: ApiMoney }[]
  subtotal: ApiMoney
  promotion: { code: string; applied: boolean; reason?: string } | null
  discount: ApiMoney
  total: ApiMoney
  issues: { kind: string; lineId: string }[]
}

/** The applied promo code as the bag shows it: the API checks it again on every read. */
export type BagPromotion = { code: string; applied: true } | { code: string; applied: false; message: string }

/** Why a code does not apply, in the shop's words (reasons from the API's promotion engine). */
export function promotionMessage(reason: string | undefined) {
  switch (reason) {
    case "expired":
      return "This code has expired."
    case "not_started":
      return "This code is not active yet."
    case "minimum_not_met":
      return "Your bag does not reach this code's minimum spend."
    case "usage_limit_reached":
      return "This code has been fully used."
    case "per_customer_limit_reached":
      return "You have already used this code."
    default:
      return "This code is not valid."
  }
}

type CartContextValue = {
  lines: CartLine[]
  count: number
  subtotal: Money
  open: boolean
  setOpen: (open: boolean) => void
  busy: boolean
  add: (product: Product, variant: Variant) => Promise<boolean>
  setQuantity: (lineId: string, quantity: number) => Promise<void>
  /** The applied promo code, the discount it gives now and the bag total after it (all from the API). */
  promotion: BagPromotion | null
  discount: Money
  total: Money
  /** Applies a promo code; resolves to the shopper-facing error when it does not apply, else null. */
  applyCode: (code: string) => Promise<string | null>
  removeCode: () => Promise<void>
  /** Reloads the bag from the API, here and in other tabs (after signing in or out the bag changes owner). */
  refresh: () => void
}

const CartContext = React.createContext<CartContextValue | null>(null)

export function useCart() {
  const value = React.useContext(CartContext)
  if (!value) throw new Error("useCart must be used inside <CartProvider>")
  return value
}

const money = (m: ApiMoney): Money => ({ amount: (m.amountPaise / 100).toFixed(2), currencyCode: m.currency })
const ZERO: Money = { amount: "0", currencyCode: "INR" }
const EMPTY: CartLine[] = []

function linesOf(cart: ApiCart | null): CartLine[] {
  if (!cart) return EMPTY
  const unavailable = new Set(cart.issues.filter(i => i.kind === "unavailable").map(i => i.lineId))
  return cart.lines.map(l => ({
    id: l.id,
    quantity: l.quantity,
    title: l.title,
    handle: l.handle,
    option: unavailable.has(l.id) ? `${optionLabel(l.variantTitle)}, no longer available` : optionLabel(l.variantTitle),
    image: l.imageUrl ?? "",
    price: money(l.unitPrice),
  }))
}

/** Calls the cart API; returns the bag, or throws with the API's message for the shopper. */
async function cartApi(path: string, init?: { method: string; body: unknown; key?: string }): Promise<ApiCart | null> {
  const response = await fetch(`/api/cart${path}`, {
    method: init?.method ?? "GET",
    headers: init?.body !== undefined ? { "content-type": "application/json", ...(init.key && { "idempotency-key": init.key }) } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
    credentials: "same-origin",
  })
  const json = (await response.json().catch(() => null)) as { data?: ApiCart | null; error?: { code: string; message: string; fields?: Record<string, string> } } | null
  if (!response.ok) {
    if (path === "/promotion" && response.status === 400 && json?.error?.fields?.code) throw new Error(promotionMessage(json.error.fields.code))
    if (response.status === 429) throw new Error("Too many tries. Wait a minute, then try again.")
    throw new Error(response.status === 409 && json?.error?.message ? json.error.message : "Your bag could not be updated. Please try again.")
  }
  return json?.data ?? null
}

// Other tabs of the shop reload the bag when this one changes it.
const CHANNEL = "chaanavya:bag"

export function CartProvider({ children }: { children: React.ReactNode }) {
  const [cart, setCart] = React.useState<ApiCart | null>(null)
  const [open, setOpen] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const channel = React.useRef<BroadcastChannel | null>(null)

  const refresh = React.useCallback(() => {
    cartApi("")
      .then(setCart)
      .catch(() => {
        /* the API is unreachable; keep showing what we have */
      })
  }, [])

  React.useEffect(() => {
    refresh()
    // The bag used to live in localStorage (before Stage 11.02); that copy is no longer used.
    try {
      localStorage.removeItem("chaanavya-demo-cart-v2")
    } catch {
      /* storage unavailable */
    }
    const bc = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL)
    channel.current = bc
    bc?.addEventListener("message", refresh)
    const onVisible = () => document.visibilityState === "visible" && refresh()
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      bc?.close()
      channel.current = null
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [refresh])

  const change = React.useCallback(async (path: string, method: string, body: unknown, key?: string) => {
    setBusy(true)
    try {
      const next = await cartApi(path, { method, body, key })
      setCart(next)
      channel.current?.postMessage("changed")
      return true
    } catch (error) {
      toast.error((error as Error).message)
      return false
    } finally {
      setBusy(false)
    }
  }, [])

  const add = React.useCallback(
    async (product: Product, variant: Variant) => {
      // One key per press: the API applies an add once even if the request is sent again.
      const added = await change("/lines", "POST", { variantId: variant.id, quantity: 1 }, crypto.randomUUID())
      if (added) toast.success(`${product.title} added to bag`, { action: { label: "View bag", onClick: () => setOpen(true) } })
      return added
    },
    [change]
  )

  const setQuantity = React.useCallback(
    async (lineId: string, quantity: number) => {
      const path = `/lines/${encodeURIComponent(lineId)}`
      // Removing uses its own route, which is safe to repeat (a line already gone changes nothing).
      if (quantity <= 0) await change(path, "DELETE", undefined)
      else await change(path, "PATCH", { quantity })
    },
    [change]
  )

  const applyCode = React.useCallback(async (code: string) => {
    setBusy(true)
    try {
      setCart(await cartApi("/promotion", { method: "POST", body: { code } }))
      channel.current?.postMessage("changed")
      return null
    } catch (error) {
      return (error as Error).message
    } finally {
      setBusy(false)
    }
  }, [])

  const removeCode = React.useCallback(async () => {
    await change("/promotion", "DELETE", undefined)
  }, [change])

  const value = React.useMemo<CartContextValue>(() => {
    const lines = linesOf(cart)
    const p = cart?.promotion
    const promotion: BagPromotion | null = p ? (p.applied ? { code: p.code, applied: true } : { code: p.code, applied: false, message: promotionMessage(p.reason) }) : null
    return {
      lines,
      count: lines.reduce((sum, l) => sum + l.quantity, 0),
      subtotal: cart ? money(cart.subtotal) : ZERO,
      promotion,
      discount: cart ? money(cart.discount) : ZERO,
      total: cart ? money(cart.total) : ZERO,
      applyCode,
      removeCode,
      open,
      setOpen,
      busy,
      add,
      setQuantity,
      refresh: () => {
        refresh()
        channel.current?.postMessage("changed")
      },
    }
  }, [cart, open, busy, add, setQuantity, applyCode, removeCode, refresh])

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>
}
