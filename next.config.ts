import type { NextConfig } from "next"

// cacheComponents / partial prerendering are off on purpose: the nonce-based CSP in proxy.ts
// needs every page rendered per request. Shopify catalogue fetches are still cached (lib/shopify.ts).
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()" },
]

const nextConfig: NextConfig = {
  poweredByHeader: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  images: {
    formats: ["image/avif", "image/webp"],
    remotePatterns: [
      { protocol: "https", hostname: "cdn.shopify.com" },
      { protocol: "https", hostname: "images.unsplash.com" },
    ],
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }]
  },
  async redirects() {
    // Keep links to the old static .html pages working.
    return [
      { source: "/index.html", destination: "/", permanent: true },
      // Essentials became Fragrance on 14 October 2026.
      { source: "/essentials", destination: "/fragrance", permanent: true },
      { source: "/essentials.html", destination: "/fragrance", permanent: true },
      // Jewellery moved from /jewelry to the Indian English spelling on 15 October 2026.
      { source: "/jewelry", destination: "/jewellery", permanent: true },
      { source: "/jewelry.html", destination: "/jewellery", permanent: true },
      { source: "/:page.html", destination: "/:page", permanent: true },
    ]
  },
}

export default nextConfig
