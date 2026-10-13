# Chaanavya Security Requirements

## Trust boundaries

The browser is untrusted. Next.js holds the configured Shopify credential and mediates cart actions. Shopify owns live commerce and checkout. The repository has no customer authentication or local role model; do not describe the current cart endpoint as an authenticated account API.

## Existing controls

| Area | Implemented control | Limit |
| --- | --- | --- |
| Browser scripts | Per-request CSP nonce, `strict-dynamic`, no production `unsafe-eval` | Proxy excludes API, assets, static/image routes, and selected prefetch requests |
| Browser styles | Same-origin with `unsafe-inline` | Inline styles intentionally permitted for UI libraries |
| Remote resources | Shopify and Unsplash image hosts; fonts and browser connections restricted to self. Google Analytics hosts (`*.googletagmanager.com`, `*.google-analytics.com`, `*.analytics.google.com`) are added to `img-src` and `connect-src` only when `NEXT_PUBLIC_GA_MEASUREMENT_ID` is set | Changes to integrations may require explicit CSP updates |
| Analytics consent | gtag.js is injected by the bundle only after the visitor accepts the cookie banner (allowed by `strict-dynamic`, no inline script); Reject removes `_ga` cookies | Consent is per browser; no server-side consent log |
| Framing and headers | Frame denial, nosniff, referrer policy, COOP, restricted permissions | Deployed headers have not been verified here |
| Cart input | Operation allowlist, clean variable copies, GID and quantity checks | GID validation is not proof of ownership |
| Request origin | Fetch-site and Origin/Host filtering | Non-browser requests can supply headers; this is not authentication |
| Abuse control | Per-instance 60-per-minute IP counter | No distributed counter; platform rule unverified |
| Checkout URL | Client requires HTTPS before navigation | No hostname allowlist is implemented |
| Credentials | Server-side environment lookup | `lib/shopify.ts` lacks a compiler-enforced `server-only` import marker |

Security headers are configured in `next.config.ts`; CSP is generated in `proxy.ts`. CSP forbids objects and embedding, restricts base URLs and form actions, and upgrades insecure requests outside development.

## Credential and data rules

- Keep Shopify configuration in private deployment environment settings or local ignored files. Never put the token in `NEXT_PUBLIC_*`, source, documentation, or client props.
- Use `.env.example` for names and safe defaults only. Do not copy `.env.local` into artifacts or print its values during diagnosis.
- Preserve `.gitignore` and `.vercelignore` exclusions for local configuration. If a credential leaks, rotate it through the responsible service and inspect exposure.
- Redact full cart IDs, especially their `key` portion, checkout URLs containing secrets, tokens, email addresses, and order details from logs.
- Treat local storage as untrusted browser state. Do not store customer credentials, payment information, or privileged authorization decisions there.
- Do not add order/customer access using only a publicly supplied order number. Define customer verification before building tracking.

## Production requirements and gaps

- Verify the production domain and Shopify domain, credential access scope, endpoint version, catalog publication, and upstream checkout host.
- Confirm hosting-wide rate controls. Code comments referring to a Vercel Firewall rule are not evidence that the rule exists.
- Enforce mock prohibition across all production hosting modes. The current code only checks `VERCEL_ENV !== "production"`; `NODE_ENV=production` alone does not block mock mode.
- Decide whether to add a `server-only` boundary and an approved checkout hostname policy.
- Review storage shape validation, cart restoration errors, raw upstream logging, and strict request byte enforcement.
- Verify deployed CSP and header behavior on page loads, navigation, overlays, and checkout handoff.
- Do not assume dependency installation or a successful build establishes a security review. Check relevant dependency changes when they occur.

These are identified checks, not declarations of a verified vulnerability exploit or completed security audit.

## Future integrations

Contact and newsletter endpoints will need server validation, abuse controls, minimal collection, delivery/error semantics, and a consent/retention decision. Tracking requires an authorization design and safe handling of failed lookups. There are no uploads now; any new upload path needs type, size, storage, and access rules before implementation.

## Launch checklist

- [ ] Live Shopify credential stays server-side and is absent from logs and browser bundles.
- [ ] Real cart, invalid input, origin rejection, and rate-limit scenarios are verified.
- [ ] Platform rate control and trusted forwarded-header behavior are confirmed for the host.
- [ ] Production never enters external mock mode.
- [ ] Checkout destination is verified against the actual Shopify setup.
- [ ] Production headers and nonce behavior are checked.
- [ ] Policy text matches the actual providers and data flows.

## Sources

`proxy.ts`, `next.config.ts`, `lib/shopify.ts`, `app/api/shopify/route.ts`, `components/cart/`, `.env.example`, `.gitignore`, and `.vercelignore`.
