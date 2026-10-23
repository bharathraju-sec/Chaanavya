"use client"

import { useEffect } from "react"

// Storefront only. Right-click works as normal (open a product in a new tab, copy a link, paste into
// a field), but photos cannot be saved from the menu or dragged out. Images ignore the pointer, so a
// right-click on a photo lands on the link or card behind it, which has no "Save image" entry; the
// handlers cover media that is still hit. A deterrent, not protection: the browser's developer tools,
// screenshots and "Save page as" still reach the files.
const STYLE = "img,picture,video{-webkit-user-drag:none;user-select:none}img{pointer-events:none}"

export function NoContextMenu() {
  useEffect(() => {
    const media = "img, picture, video, canvas"
    const block = (event: Event) => {
      if ((event.target as HTMLElement | null)?.closest?.(media)) event.preventDefault()
    }
    document.addEventListener("contextmenu", block)
    document.addEventListener("dragstart", block)
    return () => {
      document.removeEventListener("contextmenu", block)
      document.removeEventListener("dragstart", block)
    }
  }, [])
  return <style>{STYLE}</style>
}
