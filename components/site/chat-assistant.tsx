"use client"

import * as React from "react"
import Link from "next/link"
import { ArrowUpRight, Bot, LoaderCircle, MessageCircle, RotateCcw, Send } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { ORDER_ACCOUNT_URL, SUPPORT_EMAIL, SUPPORT_WHATSAPP_URL } from "@/components/site/support"

type ChatMessage = { role: "user" | "assistant"; content: string; failed?: boolean }
type ProductLink = { title: string; href: string }

const STARTERS = ["Help me find a dress", "How do I choose my size?", "Where can I see my order?"]
const HELP_PAGES = {
  "/size-guide": "Size guide",
  "/shipping-policy": "Shipping policy",
  "/refund-policy": "Returns policy",
  "/terms": "Terms",
  "/privacy-policy": "Privacy policy",
} as const

function renderAssistantText(content: string, products: ProductLink[]) {
  const matcher = /\[\[(?:product:(\/products\/[a-z0-9-]+)|page:(\/(?:size-guide|shipping-policy|refund-policy|terms|privacy-policy)))\]\]/gi
  const parts: React.ReactNode[] = []
  let cursor = 0
  let match: RegExpExecArray | null

  while ((match = matcher.exec(content))) {
    if (match.index > cursor) parts.push(content.slice(cursor, match.index))
    const product = products.find(item => item.href === match?.[1])
    const pagePath = match[2] as keyof typeof HELP_PAGES | undefined
    if (product) {
      parts.push(
        <Link key={`${product.href}-${match.index}`} href={product.href} className="label-caps inline-flex min-h-11 items-center gap-2 text-terra underline underline-offset-4">
          View {product.title}
          <ArrowUpRight className="size-4" aria-hidden />
        </Link>
      )
    } else if (pagePath && HELP_PAGES[pagePath]) {
      parts.push(
        <Link key={`${pagePath}-${match.index}`} href={pagePath} className="label-caps inline-flex min-h-11 items-center gap-2 text-terra underline underline-offset-4">
          {HELP_PAGES[pagePath]}
          <ArrowUpRight className="size-4" aria-hidden />
        </Link>
      )
    }
    cursor = matcher.lastIndex
  }

  if (cursor < content.length) parts.push(content.slice(cursor))
  return parts
}

export function ChatAssistant({ products }: { products: ProductLink[] }) {
  const [open, setOpen] = React.useState(false)
  const [messages, setMessages] = React.useState<ChatMessage[]>([])
  const [input, setInput] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [announcement, setAnnouncement] = React.useState("")
  const transcriptRef = React.useRef<HTMLDivElement>(null)
  const shouldFollowTranscript = React.useRef(true)

  React.useEffect(() => {
    const transcript = transcriptRef.current
    if (transcript && shouldFollowTranscript.current) {
      transcript.scrollTo({ top: transcript.scrollHeight, behavior: "auto" })
    }
  }, [messages])

  async function send(text = input, history = messages, clearDraft = true) {
    const content = text.trim()
    if (!content || busy || content.length > 1000) return

    shouldFollowTranscript.current = true
    // Failed exchanges are not sent back to the model.
    const clean = history.filter((message, i) => !message.failed && !(message.role === "user" && history[i + 1]?.failed))
    const next = [...clean, { role: "user" as const, content }, { role: "assistant" as const, content: "" }]
    setMessages(next)
    // Starter prompts and retries leave whatever the shopper has typed in the box.
    if (clearDraft) setInput("")
    setAnnouncement("Chaanavya is preparing a reply.")
    setBusy(true)
    const assistantIndex = next.length - 1

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next.slice(0, -1) }),
      })
      if (!response.ok || !response.body) {
        const payload = await response.json().catch(() => ({}))
        throw new Error(typeof payload.error === "string" ? payload.error : "The assistant is unavailable right now.")
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = decoder.decode(value, { stream: true })
        if (chunk) setMessages(current => current.map((message, index) => index === assistantIndex ? { ...message, content: message.content + chunk } : message))
      }
      const finalChunk = decoder.decode()
      if (finalChunk) setMessages(current => current.map((message, index) => index === assistantIndex ? { ...message, content: message.content + finalChunk } : message))
      setAnnouncement("Chaanavya has replied.")
    } catch {
      setMessages(current => current.map((message, index) => index === assistantIndex ? { ...message, failed: true, content: "I couldn’t answer just now. Please try again, or use one of the contact options below." } : message))
      setAnnouncement("The reply failed. Please try again or contact our team.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
    {/* Keeps the end of every page clear of the fixed launcher. */}
    <div aria-hidden className="h-20 bg-sand sm:h-24" />
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button className="fixed right-4 bottom-4 z-40 h-12 gap-2 border border-terra bg-terra px-4 text-white shadow-none hover:bg-terra-hover sm:right-6 sm:bottom-6">
          <MessageCircle className="size-5" strokeWidth={1.5} aria-hidden />
          <span>Ask Chaanavya</span>
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-full gap-0 border-l border-line bg-paper p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-[440px]">
        <SheetHeader className="border-b border-line bg-sand px-6 pt-6 pb-5">
          <div className="flex items-center justify-between gap-3 pr-10">
            <p className="eyebrow">Shopper support</p>
            {messages.length > 0 && (
              <button
                type="button"
                disabled={busy}
                onClick={() => { setMessages([]); setInput(""); setAnnouncement("") }}
                className="inline-flex min-h-11 items-center gap-2 px-2 text-xs text-muted-foreground underline underline-offset-4 transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-terra disabled:opacity-50"
              >
                <RotateCcw className="size-3.5" aria-hidden />
                New chat
              </button>
            )}
          </div>
          <SheetTitle className="font-serif text-3xl font-medium">Ask Chaanavya</SheetTitle>
          <SheetDescription>Product guidance, store information and a path to personal help.</SheetDescription>
        </SheetHeader>

        <div
          ref={transcriptRef}
          role="log"
          aria-label="Chat conversation"
          aria-live="off"
          aria-busy={busy}
          onScroll={event => {
            const transcript = event.currentTarget
            shouldFollowTranscript.current = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 80
          }}
          className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-5"
        >
          {messages.length === 0 && (
            <div className="space-y-5">
              <div className="max-w-[90%] border border-line bg-card p-4 leading-relaxed">
                <p>Hello. I can help you explore products, find store information, or get to order support.</p>
              </div>
              <div className="flex flex-wrap gap-2">
                {STARTERS.map(starter => (
                  <button key={starter} type="button" disabled={busy} onClick={() => void send(starter, messages, false)} className="min-h-11 border border-line-strong bg-transparent px-3 text-left text-[13px] leading-snug transition-colors hover:border-ink hover:bg-sand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-terra disabled:opacity-50">
                    {starter}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((message, index) => (
            <div key={`${message.role}-${index}`} className={message.role === "user" ? "ml-auto max-w-[88%] bg-ink px-4 py-3 text-on-dark" : "max-w-[92%] border border-line bg-card px-4 py-3 text-ink"}>
              {message.role === "assistant" && <Bot className="mb-2 size-4 text-gold-text" aria-hidden />}
              <p className="whitespace-pre-wrap break-words text-base leading-relaxed">{message.role === "assistant" ? renderAssistantText(message.content, products) : message.content}</p>
              {busy && message.role === "assistant" && index === messages.length - 1 && message.content.length === 0 && <span className="text-sm text-muted-foreground">Thinking…</span>}
              {busy && message.role === "assistant" && index === messages.length - 1 && message.content.length > 0 && <span className="mt-2 block text-xs text-muted-foreground">Writing…</span>}
              {message.failed && !busy && index === messages.length - 1 && messages[index - 1]?.role === "user" && (
                <button
                  type="button"
                  onClick={() => void send(messages[index - 1].content, messages.slice(0, index - 1), false)}
                  className="mt-3 inline-flex min-h-11 items-center gap-2 border border-ink px-3 text-[13px] font-semibold tracking-[0.08em] uppercase transition-colors hover:bg-ink hover:text-white"
                >
                  <RotateCcw className="size-3.5" aria-hidden />
                  Try again
                </button>
              )}
            </div>
          ))}
        </div>
        <p className="sr-only" role="status" aria-live="polite">{announcement}</p>

        <div className="border-t border-line bg-card px-5 pt-4 pb-[calc(16px+env(safe-area-inset-bottom))]">
          <div className="mb-2 flex flex-wrap gap-x-5 gap-y-1 text-[13px]">
            <a href={ORDER_ACCOUNT_URL} className="inline-flex min-h-11 items-center underline underline-offset-4 hover:text-terra">My orders</a>
            <a href={`mailto:${SUPPORT_EMAIL}`} className="inline-flex min-h-11 items-center underline underline-offset-4 hover:text-terra">Email support</a>
            <a href={SUPPORT_WHATSAPP_URL} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center underline underline-offset-4 hover:text-terra">WhatsApp</a>
          </div>
          <details className="group mb-3 border-t border-line pt-1">
            <summary className="flex min-h-11 cursor-pointer items-center text-[13px] underline underline-offset-4 hover:text-terra focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-terra">Browse help pages</summary>
            <div className="flex flex-wrap gap-x-5 gap-y-1 pb-2 text-[13px]">
              <Link href="/size-guide" className="inline-flex min-h-11 items-center underline underline-offset-4 hover:text-terra">Size guide</Link>
              <Link href="/shipping-policy" className="inline-flex min-h-11 items-center underline underline-offset-4 hover:text-terra">Shipping</Link>
              <Link href="/refund-policy" className="inline-flex min-h-11 items-center underline underline-offset-4 hover:text-terra">Returns</Link>
            </div>
          </details>

          <form onSubmit={event => { event.preventDefault(); void send() }} className="flex items-end gap-2 border border-line-strong bg-paper p-2 focus-within:border-terra">
            <label htmlFor="chat-message" className="sr-only">Your message</label>
            <textarea
              id="chat-message"
              value={input}
              maxLength={1000}
              onChange={event => setInput(event.target.value)}
              onKeyDown={event => {
                if (event.key === "Enter" && !event.shiftKey && !busy) {
                  event.preventDefault()
                  void send()
                }
              }}
              placeholder="Ask about a product or store info"
              rows={2}
              className="max-h-28 min-h-11 flex-1 resize-y bg-transparent px-2 py-2 text-base leading-relaxed outline-none placeholder:text-muted-foreground"
            />
            <Button type="submit" size="icon" aria-label={busy ? "Sending message" : "Send message"} disabled={busy || !input.trim()} className="h-11 w-11 shrink-0">
              {busy ? <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden /> : <Send className="size-4" aria-hidden />}
            </Button>
          </form>
          <p className="mt-2 text-xs text-muted-foreground">Press Enter to send, or Shift+Enter for a new line.</p>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">Messages are sent to an AI provider to generate replies. This site doesn’t store chat history; provider handling depends on its terms. Don’t share payment details, passwords, OTPs or sensitive personal information. <Link href="/privacy-policy" className="underline underline-offset-2 hover:text-ink">Privacy policy</Link></p>
        </div>
      </SheetContent>
    </Sheet>
    </>
  )
}
