"use client"

import * as React from "react"
import { toast } from "sonner"
import type { CartLine, Money, Product, Variant } from "@/lib/types"
import { optionLabel } from "@/lib/types"

const CART_ID_KEY = "chaanavya-shopify-cart-v1"
const DEMO_KEY = "chaanavya-demo-cart-v2"

type ShopifyCart = {
  id: string
  checkoutUrl: string
  totalQuantity: number
  cost: { subtotalAmount: Money }
  lines: {
    nodes: {
      id: string
      quantity: number
      merchandise: {
        id: string
        title: string
        image: { url: string } | null
        price: Money
        product: { title: string; handle: string; featuredImage: { url: string } | null }
      }
    }[]
  }
}

type CartContextValue = {
  live: boolean
  lines: CartLine[]
  count: number
  subtotal: Money
  checkoutUrl: string | null
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

// Preview-mode bag lives in localStorage; this store lets every tab see the same lines.
const DEMO_EVENT = "chaanavya:demo-cart"
const EMPTY: CartLine[] = []
let demoCache: { raw: string | null; value: CartLine[] } = { raw: null, value: EMPTY }
function demoSnapshot() {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(DEMO_KEY)
  } catch {
    /* storage unavailable */
  }
  if (raw !== demoCache.raw) demoCache = { raw, value: raw ? read<CartLine[]>(DEMO_KEY, EMPTY) : EMPTY }
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

async function api<T>(action: string, variables: object): Promise<T> {
  const response = await fetch("/api/shopify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, variables }),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error || "Store service unavailable")
  return payload as T
}

type MutationResult = { cart: ShopifyCart | null; userErrors?: { message: string }[] }
const unwrap = (payload: Record<string, MutationResult>, action: string) => {
  const result = payload[action]
  if (!result) throw new Error("Invalid cart response")
  if (result.userErrors?.length) throw new Error(result.userErrors.map(e => e.message).join(", "))
  if (!result.cart) throw new Error("Invalid cart response")
  return result.cart
}

const toLines = (cart: ShopifyCart | null): CartLine[] =>
  (cart?.lines.nodes ?? []).map(line => ({
    id: line.id,
    quantity: line.quantity,
    title: line.merchandise.product.title,
    handle: line.merchandise.product.handle,
    option: line.merchandise.title === "Default Title" ? "" : line.merchandise.title,
    image: line.merchandise.image?.url || line.merchandise.product.featuredImage?.url || "",
    price: line.merchandise.price,
  }))

export function CartProvider({ live, children }: { live: boolean; children: React.ReactNode }) {
  const [cart, setCart] = React.useState<ShopifyCart | null>(null)
  const demo = React.useSyncExternalStore(subscribeDemo, demoSnapshot, () => EMPTY)
  const [open, setOpen] = React.useState(false)
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    if (!live) return
    const id = read<string>(CART_ID_KEY, "")
    if (!id) return
    api<{ cart: ShopifyCart | null }>("cart", { id })
      .then(({ cart }) => (cart ? setCart(cart) : localStorage.removeItem(CART_ID_KEY)))
      .catch(() => localStorage.removeItem(CART_ID_KEY))
  }, [live])

  const saveDemo = React.useCallback((next: CartLine[]) => {
    write(DEMO_KEY, next)
    window.dispatchEvent(new Event(DEMO_EVENT))
  }, [])

  const add = React.useCallback(
    async (product: Product, variant: Variant) => {
      setBusy(true)
      try {
        if (live) {
          const line = { merchandiseId: variant.id, quantity: 1 }
          const next = cart
            ? unwrap(await api("cartLinesAdd", { cartId: cart.id, lines: [line] }), "cartLinesAdd")
            : unwrap(await api("cartCreate", { input: { lines: [line] } }), "cartCreate")
          setCart(next)
          write(CART_ID_KEY, next.id)
        } else {
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
        }
        toast.success(`${product.title} added to bag`, { action: { label: "View bag", onClick: () => setOpen(true) } })
        return true
      } catch (error) {
        toast.error((error as Error).message)
        return false
      } finally {
        setBusy(false)
      }
    },
    [live, cart, demo, saveDemo]
  )

  const setQuantity = React.useCallback(
    async (lineId: string, quantity: number) => {
      setBusy(true)
      try {
        if (live && cart) {
          const action = quantity <= 0 ? "cartLinesRemove" : "cartLinesUpdate"
          const variables = quantity <= 0 ? { cartId: cart.id, lineIds: [lineId] } : { cartId: cart.id, lines: [{ id: lineId, quantity }] }
          setCart(unwrap(await api(action, variables), action))
        } else if (!live) {
          saveDemo(quantity <= 0 ? demo.filter(l => l.id !== lineId) : demo.map(l => (l.id === lineId ? { ...l, quantity } : l)))
        }
      } catch (error) {
        toast.error((error as Error).message)
      } finally {
        setBusy(false)
      }
    },
    [live, cart, demo, saveDemo]
  )

  const value = React.useMemo<CartContextValue>(() => {
    const lines = live ? toLines(cart) : demo
    const subtotal = live
      ? cart?.cost.subtotalAmount ?? { amount: "0", currencyCode: "INR" }
      : { amount: String(demo.reduce((sum, l) => sum + Number(l.price.amount) * l.quantity, 0)), currencyCode: "INR" }
    return {
      live,
      lines,
      count: live ? cart?.totalQuantity ?? 0 : demo.reduce((sum, l) => sum + l.quantity, 0),
      subtotal,
      checkoutUrl: live ? cart?.checkoutUrl ?? null : null,
      open,
      setOpen,
      busy,
      add,
      setQuantity,
    }
  }, [live, cart, demo, open, busy, add, setQuantity])

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>
}
