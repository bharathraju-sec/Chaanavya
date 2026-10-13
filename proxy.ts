import { NextResponse, type NextRequest } from "next/server"
import { isMeasurementId } from "@/lib/consent"

// Strict Content Security Policy with a fresh script nonce per request. Next.js reads the nonce
// from this header and attaches it to its own scripts, so no inline script runs without it.
// Styles allow 'unsafe-inline' because Radix and next/image set style attributes.
export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64")
  const isDev = process.env.NODE_ENV === "development"
  // Google Analytics hosts, allowed only when a Measurement ID is configured. gtag.js itself is
  // loaded by our nonced bundle after cookie consent, which 'strict-dynamic' permits.
  const ga = isMeasurementId(process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID)
    ? " https://*.googletagmanager.com https://*.google-analytics.com https://*.analytics.google.com"
    : ""

  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: https://cdn.shopify.com https://images.unsplash.com${ga}`,
    "font-src 'self'",
    `connect-src 'self'${ga}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(isDev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ")

  const requestHeaders = new Headers(request.headers)
  requestHeaders.set("x-nonce", nonce)
  requestHeaders.set("Content-Security-Policy", csp)

  const response = NextResponse.next({ request: { headers: requestHeaders } })
  response.headers.set("Content-Security-Policy", csp)
  return response
}

export const config = {
  matcher: [
    {
      source: "/((?!api|_next/static|_next/image|assets|favicon.ico|icon.png|apple-icon.png).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
}
