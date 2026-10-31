import { NextResponse, type NextRequest } from "next/server"
import { isMeasurementId } from "@/lib/consent"
import { checkoutReviewOpen } from "@/lib/checkout"
import { isPayPath, RAZORPAY_CHECKOUT_HOSTS } from "@/lib/payment-handoff"
import { mediaOrigins } from "@chaanavya/shared/media"
import { adminUrl, isAdminHost } from "@chaanavya/shared/admin/host"

const isAdminPath = (path: string) => path === "/admin" || path.startsWith("/admin/")

/**
 * Admin on its own host (lib/admin/host.ts, decision 029). With ADMIN_URL set:
 * on the admin host "/orders" is served by app/admin/orders and "/admin/..." redirects to the
 * short form; on every other host "/admin..." gets the ordinary 404 page.
 */
function routeAdminHost(request: NextRequest): { redirect?: URL; rewrite?: URL; adminHost: boolean } {
  if (!adminUrl()) return { adminHost: false }
  const { pathname, search } = request.nextUrl
  if (isAdminHost(request.headers)) {
    if (isAdminPath(pathname)) return { redirect: new URL(`${pathname.slice("/admin".length) || "/"}${search}`, request.url), adminHost: true }
    return { rewrite: new URL(`/admin${pathname === "/" ? "" : pathname}${search}`, request.url), adminHost: true }
  }
  if (isAdminPath(pathname)) return { rewrite: new URL("/_not-found-admin-elsewhere", request.url), adminHost: false }
  return { adminHost: false }
}

// Strict Content Security Policy with a fresh script nonce per request. Next.js reads the nonce
// from this header and attaches it to its own scripts, so no inline script runs without it.
// Styles allow 'unsafe-inline' because Radix and next/image set style attributes.
// Router prefetches get no CSP header (they are data, not documents) but are still host-routed.
export function proxy(request: NextRequest) {
  const routed = routeAdminHost(request)
  if (routed.redirect) return NextResponse.redirect(routed.redirect, 308)
  const prefetch = request.headers.has("next-router-prefetch") || request.headers.get("purpose") === "prefetch"

  const nonce = Buffer.from(crypto.randomUUID()).toString("base64")
  const isDev = process.env.NODE_ENV === "development"
  // Google Analytics hosts, allowed only when a Measurement ID is configured. gtag.js itself is
  // loaded by our nonced bundle after cookie consent, which 'strict-dynamic' permits.
  const ga = isMeasurementId(process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID)
    ? " https://*.googletagmanager.com https://*.google-analytics.com https://*.analytics.google.com"
    : ""

  // Product photos (Stage 08): approved photos on every page; the bucket's signed upload and
  // preview links on admin pages only, where staff upload photos straight to storage.
  const media = mediaOrigins(process.env)
  const adminPage = routed.adminHost || isAdminPath(request.nextUrl.pathname)
  const photos = [media.public, adminPage ? media.upload : null].filter((o, i, all): o is string => Boolean(o) && all.indexOf(o) === i).map(o => ` ${o}`).join("")
  const uploads = adminPage && media.upload ? ` ${media.upload}` : ""

  // Razorpay's checkout (Stage 14.06): on the pay page only, its script, its payment frame and the hosts
  // the frame talks to. The buyer's payment details are typed into that frame, on Razorpay's host.
  const pay = !adminPage && checkoutReviewOpen(process.env) && isPayPath(request.nextUrl.pathname)
  const rzp = (hosts: readonly string[]) => (pay ? hosts.map(h => ` ${h}`).join("") : "")

  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${rzp(RAZORPAY_CHECKOUT_HOSTS.script)}${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: https://images.unsplash.com${photos}${ga}${rzp(RAZORPAY_CHECKOUT_HOSTS.img)}`,
    "font-src 'self'",
    `connect-src 'self'${uploads}${ga}${rzp(RAZORPAY_CHECKOUT_HOSTS.connect)}`,
    ...(pay ? [`frame-src${rzp(RAZORPAY_CHECKOUT_HOSTS.frame)}`] : []),
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(isDev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ")

  const requestHeaders = new Headers(request.headers)
  if (!prefetch) {
    requestHeaders.set("x-nonce", nonce)
    requestHeaders.set("Content-Security-Policy", csp)
  }

  const init = { request: { headers: requestHeaders } }
  const response = routed.rewrite ? NextResponse.rewrite(routed.rewrite, init) : NextResponse.next(init)
  if (!prefetch) response.headers.set("Content-Security-Policy", csp)
  if (routed.adminHost) response.headers.set("X-Robots-Tag", "noindex, nofollow")
  return response
}

export const config = {
  matcher: [
    {
      source: "/((?!api|_next/static|_next/image|assets|favicon.ico|icon.png|apple-icon.png).*)",
    },
  ],
}
