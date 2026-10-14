// Server-only: the chat assistant answers policy questions from the site's own pages, read as
// plain text, so its answers always match what customers can see. Never import from a client component.

const PAGES = [
  { path: "/shipping-policy", title: "Shipping policy" },
  { path: "/refund-policy", title: "Return, exchange & refund policy" },
  { path: "/terms", title: "Terms & conditions" },
  { path: "/privacy-policy", title: "Privacy policy" },
  { path: "/size-guide", title: "Size guide" },
  { path: "/contact", title: "Contact" },
  { path: "/track-order", title: "Track order" },
] as const

const CACHE_MS = 60 * 60 * 1000
const TIMEOUT_MS = 8000
let cached: { origin: string; text: string; at: number } | null = null

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"' }

/** Text of the page's <main>: scripts and markup removed, block elements kept as line breaks. */
function mainText(html: string) {
  const start = html.indexOf('<main id="main-content"')
  const end = html.lastIndexOf("</main>")
  if (start === -1 || end === -1) return ""
  return html
    .slice(start, end)
    .replace(/<(script|style|svg|noscript)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(td|th)>/gi, " | ")
    .replace(/<\/caption>/gi, "\n")
    .replace(/<\/(p|li|h[1-6]|div|section|tr)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
      if (code[0] !== "#") return ENTITIES[code.toLowerCase()] ?? entity
      const point = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : Number(code.slice(1))
      return Number.isFinite(point) ? String.fromCodePoint(point) : entity
    })
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim()
}

async function readPage(origin: string, path: string) {
  try {
    const response = await fetch(new URL(path, origin), { signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" })
    return response.ok ? mainText(await response.text()) : ""
  } catch {
    return ""
  }
}

/** All store pages as one text block, refreshed hourly. Pages that fail to load are listed by link only. */
export async function storePagesText(origin: string) {
  if (cached && cached.origin === origin && Date.now() - cached.at < CACHE_MS) return cached.text
  const texts = await Promise.all(PAGES.map(page => readPage(origin, page.path)))
  const text = PAGES.map((page, i) => `## ${page.title} (${page.path})\n${texts[i] || "This page could not be loaded. Point the customer to the link."}`).join("\n\n")
  // Cache only a complete read, so a failed page is retried on the next message.
  if (texts.every(Boolean)) cached = { origin, text, at: Date.now() }
  return text
}
