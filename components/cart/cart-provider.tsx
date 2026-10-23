"use client"

import * as React from "react"
import { toast } from "sonner"
import type { CartLine, Money, Product, Variant } from "@/lib/types"
import { optionLabel } from "@/lib/types"

// The bag lives in this browser only (localStorage) until Chaanavya checkout exists (Stage 11).
// Placeholder products, placeholder prices; nothing is reserved or charged.
const BAG_KEY = "chaanavya-demo-cart-v2"

type CartContextValue = {
  lines: CartLine[]
  count: number
  subtotal: Money
  open: boolean
  setOpen: (open: boolean) => void
  busy: boolean
  add: (product: Product, variant: Variant) => Promise<boolean>
  setQuantity: (lineId: string, quantity: number) => Promise<void>
}

const CartContext = React.createContext<CartContextValue | null>(null)

export function useCart() {
  const value = React.useContext(CartContext)
  if (!value) throw new Error("useCart must be used inside <CartProvider>")
  return value
}

const read = <T,>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}
const write = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage unavailable (private mode); the cart still works for this page view */
  }
}

// This store lets every tab see the same bag.
const DEMO_EVENT = "chaanavya:demo-cart"
const EMPTY: CartLine[] = []
let demoCache: { raw: string | null; value: CartLine[] } = { raw: null, value: EMPTY }
function demoSnapshot() {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(BAG_KEY)
  } catch {
    /* storage unavailable */
  }
  if (raw !== demoCache.raw) demoCache = { raw, value: raw ? read<CartLine[]>(BAG_KEY, EMPTY) : EMPTY }
  return demoCache.value
}
function subscribeDemo(callback: () => void) {
  window.addEventListener(DEMO_EVENT, callback)
  window.addEventListener("storage", callback)
  return () => {
    window.removeEventListener(DEMO_EVENT, callback)
    window.removeEventListener("storage", callback)
  }
}

export function CartProvider({ children }: { children: React.ReactNode }) {
  const demo = React.useSyncExternalStore(subscribeDemo, demoSnapshot, () => EMPTY)
  const [open, setOpen] = React.useState(false)
  const [busy, setBusy] = React.useState(false)

  const saveDemo = React.useCallback((next: CartLine[]) => {
    write(BAG_KEY, next)
    window.dispatchEvent(new Event(DEMO_EVENT))
  }, [])

  const add = React.useCallback(
    async (product: Product, variant: Variant) => {
      setBusy(true)
      try {
        const existing = demo.find(l => l.id === variant.id)
        saveDemo(
          existing
            ? demo.map(l => (l.id === variant.id ? { ...l, quantity: l.quantity + 1 } : l))
            : [
                ...demo,
                {
                  id: variant.id,
                  quantity: 1,
                  title: product.title,
                  handle: product.handle,
                  option: optionLabel(variant.title),
                  image: variant.image?.url || product.featuredImage?.url || "",
                  price: variant.price,
                },
              ]
        )
        toast.success(`${product.title} added to bag`, { action: { label: "View bag", onClick: () => setOpen(true) } })
        return true
      } finally {
        setBusy(false)
      }
    },
    [demo, saveDemo]
  )

  const setQuantity = React.useCallback(
    async (lineId: string, quantity: number) => {
      saveDemo(quantity <= 0 ? demo.filter(l => l.id !== lineId) : demo.map(l => (l.id === lineId ? { ...l, quantity } : l)))
    },
    [demo, saveDemo]
  )

  const value = React.useMemo<CartContextValue>(
    () => ({
      lines: demo,
      count: demo.reduce((sum, l) => sum + l.quantity, 0),
      subtotal: { amount: String(demo.reduce((sum, l) => sum + Number(l.price.amount) * l.quantity, 0)), currencyCode: "INR" },
      open,
      setOpen,
      busy,
      add,
      setQuantity,
    }),
    [demo, open, busy, add, setQuantity]
  )

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>
}
