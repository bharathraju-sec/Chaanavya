// The admin workspace has its own address (decision 029), configured by ADMIN_URL, for example
// https://admin.chaanavya.in. When it is set:
//   - on the admin host, "/orders" serves app/admin/orders (proxy.ts rewrites to /admin/...);
//   - on any other host, /admin pages and /api/admin routes answer 404.
// Session cookies are host-only, so a sign-in on the shop never reaches the admin host and back.
// Without ADMIN_URL (local development), the admin is served at /admin on the current host.
// Self-contained: proxy.ts (edge-compatible) and server code both import it.

export function adminUrl(env: Readonly<Record<string, string | undefined>> = process.env): URL | null {
  const raw = env.ADMIN_URL?.trim()
  if (!raw) return null
  try {
    return new URL(raw)
  } catch {
    return null
  }
}

/** Host (with port) the browser asked for. Vercel sets x-forwarded-host to the public domain. */
export const requestHost = (headers: Headers) => (headers.get("x-forwarded-host") ?? headers.get("host") ?? "").split(",")[0].trim().toLowerCase()

export function isAdminHost(headers: Headers, env?: Readonly<Record<string, string | undefined>>) {
  const url = adminUrl(env)
  return Boolean(url && requestHost(headers) === url.host.toLowerCase())
}

/** Admin pages and APIs may be served for this request. */
export const adminAllowedHere = (headers: Headers, env?: Readonly<Record<string, string | undefined>>) => !adminUrl(env) || isAdminHost(headers, env)

/** Prefix for admin links: "" on the admin host, "/admin" when served under the main site. */
export const adminBasePath = (headers: Headers, env?: Readonly<Record<string, string | undefined>>) => (isAdminHost(headers, env) ? "" : "/admin")
