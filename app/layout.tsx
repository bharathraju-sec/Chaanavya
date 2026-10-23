import type { Metadata, Viewport } from "next"
import { Cormorant, Montserrat } from "next/font/google"
import { connection } from "next/server"
import "./globals.css"

const cormorant = Cormorant({ subsets: ["latin"], weight: ["400", "500", "600"], style: ["normal", "italic"], variable: "--font-cormorant", display: "swap" })
const montserrat = Montserrat({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-montserrat", display: "swap" })

export const metadata: Metadata = {
  metadataBase: new URL("https://chaanavya.in"),
  title: { default: "Chaanavya | Organic Cotton Clothing", template: "%s | Chaanavya" },
  description: "Chaanavya: regal fashion for women. Sarees, gowns, fine jewellery and everyday luxe.",
  icons: {
    icon: [
      { url: "/assets/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/assets/favicon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: "/assets/apple-touch-icon.png",
  },
  openGraph: {
    type: "website",
    locale: "en_IN",
    siteName: "Chaanavya",
    title: "Chaanavya | Organic Cotton Clothing",
    description: "Rooted in nature. Styled for you.",
    images: ["/assets/og-image.png"],
  },
  twitter: { card: "summary_large_image" },
}

export const viewport: Viewport = { themeColor: "#FBF7F0" }

// Root layout: document, fonts and metadata only. The storefront chrome lives in app/(store)/layout.tsx
// (StoreShell) and the admin workspace has its own shell in app/admin, so neither leaks into the other.
export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Every page renders per request so proxy.ts can attach a fresh CSP nonce.
  await connection()
  return (
    <html lang="en-IN" className={`${cormorant.variable} ${montserrat.variable}`}>
      <body className="flex min-h-svh flex-col overflow-x-hidden">{children}</body>
    </html>
  )
}
