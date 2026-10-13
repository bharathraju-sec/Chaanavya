"use client"

import * as React from "react"
import { Heart } from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"

const KEY = "chaanavya-wishlist-v2"
const EVENT = "chaanavya:wishlist"

function readList(): string[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "[]")
  } catch {
    return []
  }
}

function subscribe(callback: () => void) {
  window.addEventListener(EVENT, callback)
  window.addEventListener("storage", callback)
  return () => {
    window.removeEventListener(EVENT, callback)
    window.removeEventListener("storage", callback)
  }
}

export function WishlistButton({ handle, title, className }: { handle: string; title: string; className?: string }) {
  const saved = React.useSyncExternalStore(subscribe, () => readList().includes(handle), () => false)

  const toggle = () => {
    const list = readList()
    const next = saved ? list.filter(h => h !== handle) : [...list, handle]
    try {
      localStorage.setItem(KEY, JSON.stringify(next))
    } catch {
      /* storage unavailable */
    }
    window.dispatchEvent(new Event(EVENT))
    toast(saved ? "Removed from wishlist" : "Saved to wishlist")
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={saved}
      aria-label={`Save ${title} to wishlist`}
      className={cn(
        "grid size-11 place-items-center rounded-full bg-paper/90 text-ink transition-colors duration-200 hover:text-terra aria-pressed:text-terra",
        className
      )}
    >
      <Heart className={cn("size-[18px]", saved && "fill-current")} strokeWidth={1.5} aria-hidden />
    </button>
  )
}
