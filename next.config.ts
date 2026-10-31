import type { NextConfig } from "next"

// Product photos are served from the photo store (decision 034): MEDIA_PUBLIC_BASE_URL, or the local
// S3Mock from compose.yaml in development. next/image may load only from there and from Unsplash
// (placeholder editorial photos). Local addresses are refused by default, so they are allowed in
// development only.
const development = process.env.NODE_ENV !== "production"
const DEVELOPMENT_MEDIA = "http://127.0.0.1:9090/chaanavya-media/"
function mediaPattern() {
  try {
    const base = new URL(process.env.MEDIA_PUBLIC_BASE_URL?.trim() || (development ? DEVELOPMENT_MEDIA : ""))
    return [{ protocol: base.protocol.replace(":", "") as "http" | "https", hostname: base.hostname, ...(base.port && { port: base.port }), pathname: `${base.pathname.replace(/\/?$/, "/")}**` }]
  } catch {
    return []
  }
}

// cacheComponents / partial prerendering are off on purpose: the nonce-based CSP in proxy.ts
// needs every page rendered per request.
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()" },
]
// Razorpay's checkout opens some payment methods (net banking, card authentication) in a pop-up that
// reports back to its window, which "same-origin" would cut off. The pay page alone (Stage 14.06,
// lib/payment-handoff.ts) allows its own pop-ups; every other page keeps "same-origin".
// The same paths as PAY_PATH in lib/payment-handoff.ts: one order id, nothing after it.
const ORDER_ID = "[0-9a-fA-F-]{36}"
const PAY_PAGE = `/checkout/pay/:orderId(${ORDER_ID})`
const openerPolicies = [
  { source: `/:path((?!checkout/pay/${ORDER_ID}$).*)`, headers: [{ key: "Cross-Origin-Opener-Policy", value: "same-origin" }] },
  { source: PAY_PAGE, headers: [{ key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" }] },
]

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Workspace packages ship TypeScript source (Stage 07).
  transpilePackages: ["@chaanavya/shared", "@chaanavya/contracts"],
  turbopack: {
    // Pin the root to this folder so a copy nested in another checkout uses its own lockfile.
    root: __dirname,
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  images: {
    formats: ["image/avif", "image/webp"],
    remotePatterns: [{ protocol: "https", hostname: "images.unsplash.com" }, ...mediaPattern()],
    dangerouslyAllowLocalIP: development,
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }, ...openerPolicies]
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
