"use client"

import * as React from "react"
import Image from "next/image"
import Link from "next/link"
import { ArrowUp, LoaderCircle, MessageCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { SUPPORT_WHATSAPP_URL } from "@/components/site/support"

type Product = { handle: string; title: string; price: string; image: string | null; available: boolean }
type Turn = { role: "user" | "assistant"; text: string; products?: Product[] }

const MAX_TURNS = 12
const MAX_CHARS = 500
const SUGGESTIONS = ["Where is my order?", "Do you ship across India?", "How do returns work?", "Show me sarees"]

/** The conversation sent to the server: the latest turns, always starting with a customer message. */
function payload(turns: Turn[]) {
  const recent = turns.slice(-MAX_TURNS)
  while (recent.length && recent[0].role !== "user") recent.shift()
  return recent.map(({ role, text }) => ({ role, text }))
}

export function ChatWidget({ enabled }: { enabled: boolean }) {
  const [open, setOpen] = React.useState(false)
  const [turns, setTurns] = React.useState<Turn[]>([])
  const [draft, setDraft] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState("")
  const listRef = React.useRef<HTMLDivElement>(null)
  const inputRef = React.useRef<HTMLTextAreaElement>(null)

  // Keep the newest message in view.
  React.useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [turns, busy, error])

  async function send(text: string) {
    const message = text.trim().slice(0, MAX_CHARS)
    if (!message || busy) return
    const next: Turn[] = [...turns, { role: "user", text: message }]
    setTurns(next)
    setDraft("")
    setError("")
    setBusy(true)
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: payload(next) }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || typeof data.reply !== "string") throw new Error(typeof data.error === "string" ? data.error : "Our assistant couldn't answer right now. Please try again.")
      setTurns([...next, { role: "assistant", text: data.reply, products: Array.isArray(data.products) ? data.products : [] }])
    } catch (failure) {
      // Take the unanswered message back out so the conversation stays valid, and return it to the box.
      setTurns(turns)
      setDraft(message)
      setError((failure as Error).message)
    } finally {
      setBusy(false)
      inputRef.current?.focus()
    }
  }

  if (!enabled) return null

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Chat with Chaanavya"
        className="fixed right-4 bottom-[calc(16px+env(safe-area-inset-bottom))] z-30 grid size-14 place-items-center bg-ink text-white transition-colors duration-200 hover:bg-terra sm:right-6 sm:bottom-6"
      >
        <MessageCircle className="size-6" strokeWidth={1.5} aria-hidden />
      </button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="right"
          className="gap-0 bg-paper p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-[420px]"
          onOpenAutoFocus={event => {
            event.preventDefault()
            inputRef.current?.focus()
          }}
        >
          <SheetHeader className="border-b border-line px-6 pt-6 pb-5">
            <p className="eyebrow">Ask Chaanavya</p>
            <SheetTitle className="font-serif text-4xl font-medium">How can we help?</SheetTitle>
            <SheetDescription className="text-[13px] leading-snug text-muted-foreground">
              An AI assistant answers from our products, your order details and our policy pages. It can make mistakes, so check details on the page it names.
            </SheetDescription>
          </SheetHeader>

          <div ref={listRef} className="flex-1 overflow-y-auto px-6 py-5" aria-live="polite">
            {turns.length === 0 && (
              <div>
                <p className="text-[15px] leading-relaxed">Ask about products, sizes, your order, shipping or returns. For order status, have your order number and checkout email ready.</p>
                <ul className="mt-5 flex flex-wrap gap-2">
                  {SUGGESTIONS.map(suggestion => (
                    <li key={suggestion}>
                      <button
                        type="button"
                        onClick={() => send(suggestion)}
                        className="min-h-11 border border-line-strong bg-card px-3.5 text-left text-[13px] transition-colors duration-200 hover:border-ink"
                      >
                        {suggestion}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <ol className="space-y-4">
              {turns.map((turn, i) => (
                <li key={i} className={turn.role === "user" ? "flex justify-end" : ""}>
                  {turn.role === "user" ? (
                    <p className="max-w-[85%] bg-ink px-4 py-3 text-[15px] leading-relaxed whitespace-pre-wrap text-white">{turn.text}</p>
                  ) : (
                    <div className="max-w-[92%]">
                      <p className="border border-line bg-card px-4 py-3 text-[15px] leading-relaxed whitespace-pre-wrap">{turn.text}</p>
                      {turn.products && turn.products.length > 0 && (
                        <ul className="mt-2 space-y-2">
                          {turn.products.map(product => (
                            <li key={product.handle}>
                              <Link
                                href={`/products/${product.handle}`}
                                onClick={() => setOpen(false)}
                                className="grid grid-cols-[56px_1fr] items-center gap-3 border border-line bg-card p-2 transition-colors duration-200 hover:border-ink"
                              >
                                <span className="relative block h-[70px] w-14 bg-well">
                                  {product.image && <Image src={product.image} alt="" fill sizes="56px" className="object-cover" />}
                                </span>
                                <span>
                                  <span className="block font-serif text-lg leading-tight">{product.title}</span>
                                  <span className="mt-0.5 block text-[13px] text-muted-foreground">
                                    {product.price}
                                    {!product.available && " · Sold out"}
                                  </span>
                                </span>
                              </Link>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ol>

            {busy && (
              <p className="mt-4 flex items-center gap-2 text-[13px] text-muted-foreground">
                <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden />
                Finding an answer…
              </p>
            )}
            {error && (
              <p role="alert" className="mt-4 text-[13px] text-destructive">
                {error}
              </p>
            )}
          </div>

          <form
            onSubmit={event => {
              event.preventDefault()
              send(draft)
            }}
            className="border-t border-line bg-card px-6 pt-4 pb-[calc(16px+env(safe-area-inset-bottom))]"
          >
            <label htmlFor="chat-message" className="sr-only">
              Your message
            </label>
            <div className="flex items-end gap-2">
              <textarea
                id="chat-message"
                ref={inputRef}
                rows={2}
                maxLength={MAX_CHARS}
                value={draft}
                onChange={event => setDraft(event.target.value)}
                onKeyDown={event => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault()
                    send(draft)
                  }
                }}
                placeholder="Type your question"
                className="min-h-12 flex-1 resize-none border border-line-strong bg-paper px-3.5 py-3 text-base outline-none transition-colors placeholder:text-muted-foreground focus:border-ink"
              />
              <Button type="submit" size="icon" className="size-12" disabled={busy || !draft.trim()} aria-label="Send message">
                <ArrowUp className="size-5" aria-hidden />
              </Button>
            </div>
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
              Never share card or UPI details here. You can also use{" "}
              <Link href="/track-order" onClick={() => setOpen(false)} className="underline underline-offset-2 hover:text-ink">
                Track order
              </Link>{" "}
              or{" "}
              <a href={SUPPORT_WHATSAPP_URL} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-ink">
                WhatsApp us
              </a>
              .
            </p>
          </form>
        </SheetContent>
      </Sheet>
    </>
  )
}
