import type { Metadata, Viewport } from "next"
import { Cormorant, Montserrat } from "next/font/google"
import { connection } from "next/server"
import { CartProvider } from "@/components/cart/cart-provider"
import { CartSheet } from "@/components/cart/cart-sheet"
import { SiteFooter } from "@/components/site/footer"
import { SiteHeader } from "@/components/site/header"
import { Toaster } from "@/components/ui/sonner"
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
          <SiteFooter />
          <CartSheet />
        </CartProvider>
        <Toaster position="bottom-right" />
      </body>
    </html>
  )
}
