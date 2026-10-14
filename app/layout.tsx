import type { Metadata, Viewport } from "next"
import { Cormorant, Montserrat } from "next/font/google"
import { connection } from "next/server"
import { CartProvider } from "@/components/cart/cart-provider"
import { CartSheet } from "@/components/cart/cart-sheet"
import { ChatWidget } from "@/components/chat/chat-widget"
import { CookieConsent } from "@/components/consent/cookie-consent"
import { SiteFooter } from "@/components/site/footer"
import { SiteHeader } from "@/components/site/header"
import { WelcomePopup } from "@/components/marketing/welcome-popup"
import { Toaster } from "@/components/ui/sonner"
import { isChatConfigured } from "@/lib/chat/assistant"
import { isMeasurementId } from "@/lib/consent"
import { isNewsletterConfigured } from "@/lib/marketing/newsletter"
import { getProducts } from "@/lib/shopify"
import "./globals.css"

const cormorant = Cormorant({ subsets: ["latin"], weight: ["400", "500", "600"], style: ["normal", "italic"], variable: "--font-cormorant", display: "swap" })
const montserrat = Montserrat({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-montserrat", display: "swap" })

export const metadata: Metadata = {
  metadataBase: new URL("https://chaanavya.in"),
  title: { default: "Chaanavya | Organic Cotton Clothing", template: "%s | Chaanavya" },
  description: "Chaanavya: regal fashion for women. Sarees, gowns, fine jewelry and everyday luxe.",
  icons: {
    icon: [
      { url: "/assets/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/assets/favicon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: "/assets/apple-touch-icon.png",
  },
  openGraph: {
    type: "website",
    siteName: "Chaanavya",
    title: "Chaanavya | Organic Cotton Clothing",
    description: "Rooted in nature. Styled for you.",
    images: ["/assets/og-image.png"],
  },
  twitter: { card: "summary_large_image" },
}

export const viewport: Viewport = { themeColor: "#FBF7F0" }

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Every page renders per request so proxy.ts can attach a fresh CSP nonce.
  await connection()
  const { products, live } = await getProducts()
  const searchEntries = products.map(p => ({ label: p.title, href: `/products/${p.handle}` }))
  // Cookie banner: live once a GA4 Measurement ID is configured; always shown in local development for review.
  const gaId = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID
  const cookieConsent = isMeasurementId(gaId) || process.env.NODE_ENV === "development"
  const chat = isChatConfigured()

  return (
    <html lang="en" className={`${cormorant.variable} ${montserrat.variable}`}>
      <body className="flex min-h-svh flex-col overflow-x-hidden">
        <a href="#main-content" className="fixed -top-20 left-3 z-[300] bg-card px-4 py-3 text-sm focus:top-3">
          Skip to content
        </a>
        <CartProvider live={live}>
          <SiteHeader searchEntries={searchEntries} />
          <main id="main-content" className="flex-1">
            {children}
          </main>
          <SiteFooter cookieSettings={cookieConsent} />
          <CartSheet />
        </CartProvider>
        {cookieConsent && <CookieConsent measurementId={gaId} />}
        {/* Newsletter popup: live only once Shopify Admin credentials are configured; always shown in local development for review. */}
        <WelcomePopup enabled={isNewsletterConfigured() || process.env.NODE_ENV === "development"} waitForConsent={cookieConsent} />
        {/* Shop chat: shown only when enabled in lib/chat/assistant.ts and ANTHROPIC_API_KEY is set. */}
        <ChatWidget enabled={chat} />
        {/* Raised while the chat button shows, so toasts never cover it. */}
        <Toaster position="bottom-right" {...(chat && { offset: { bottom: 96 }, mobileOffset: { bottom: 88 } })} />
      </body>
    </html>
  )
}
