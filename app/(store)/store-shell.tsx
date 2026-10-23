import { CartProvider } from "@/components/cart/cart-provider"
import { CartSheet } from "@/components/cart/cart-sheet"
import { ChatWidget } from "@/components/chat/chat-widget"
import { CookieConsent } from "@/components/consent/cookie-consent"
import { SiteFooter } from "@/components/site/footer"
import { SiteHeader } from "@/components/site/header"
import { Toaster } from "@/components/ui/sonner"
import { isChatConfigured } from "@/lib/chat/assistant"
import { isMeasurementId } from "@/lib/consent"
import { getSearchProducts } from "@/lib/catalogue/storefront"
import { accountLink } from "@/lib/auth/account-link"

// Storefront chrome: bag, header, footer, cookie banner and chat. Used by the
// app/(store) layout and the global 404 page; the admin workspace (app/admin) has its own shell.
// Lives under app/ because it reads server-only modules (catalogue, chat, sign-in state).
export async function StoreShell({ children }: { children: React.ReactNode }) {
  const [products, account] = await Promise.all([getSearchProducts(), accountLink()])
  const searchEntries = products.map(p => ({ label: p.title, href: `/products/${p.handle}` }))
  // Cookie banner: live once a GA4 Measurement ID is configured; always shown in local development for review.
  const gaId = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID
  const cookieConsent = isMeasurementId(gaId) || process.env.NODE_ENV === "development"
  const chat = isChatConfigured()

  return (
    <>
      <a href="#main-content" className="fixed -top-20 left-3 z-[300] bg-card px-4 py-3 text-sm focus:top-3">
        Skip to content
      </a>
      <CartProvider>
        <SiteHeader searchEntries={searchEntries} account={account} />
        <main id="main-content" className="flex-1">
          {children}
        </main>
        <SiteFooter cookieSettings={cookieConsent} />
        <CartSheet />
      </CartProvider>
      {cookieConsent && <CookieConsent measurementId={gaId} />}
      {/* Shop chat: shown only when enabled in lib/chat/assistant.ts and ANTHROPIC_API_KEY is set. */}
      <ChatWidget enabled={chat} />
      {/* Raised while the chat button shows, so toasts never cover it. */}
      <Toaster position="bottom-right" {...(chat && { offset: { bottom: 96 }, mobileOffset: { bottom: 88 } })} />
    </>
  )
}
