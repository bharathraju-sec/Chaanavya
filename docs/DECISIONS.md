# Chaanavya Architecture Decisions

These records describe choices visible in the existing source on 13 October 2026. They do not invent an approval history. Changes to these choices should update the record with the reason and resulting tradeoff.

## 001 Next.js storefront with Shopify commerce

Status: implemented. Sources: `package.json`, `app/`, `lib/shopify.ts`.

Decision: use one Next.js App Router app for presentation and server integration; Shopify supplies catalog, cart, and checkout. Consequence: no duplicated local commerce database or payment implementation. Tradeoff: upstream availability, API compatibility, and Shopify settings affect purchasing. Alternatives for future evaluation include a custom backend or a different storefront framework; no historical evaluation of them is claimed.

## 002 Preserve the warm editorial brand

Status: existing design authority. Source: `design-system/chaanavya/MASTER.md`.

Decision: use ivory, teal, gold, and terracotta, Cormorant/Montserrat, spacious layouts, and square controls. The master records that an automatic glass-style recommendation was rejected. Consequence: shared tokens and primitives keep pages consistent. Tradeoff: generic new component styles must be adapted to this brand.

## 003 Render pages per request for CSP nonces

Status: implemented. Sources: `app/layout.tsx`, `proxy.ts`, `next.config.ts`.

Decision: use `connection()` with a fresh page script nonce and keep component caching/partial prerendering off. Catalog fetches remain cached for 300 seconds. Consequence: stricter script policy with dynamic page rendering. Tradeoff: rendering has a per-request cost; cache policy must not reuse nonce-dependent HTML.

## 004 Allowlisted same-origin cart endpoint

Status: implemented. Source: `app/api/shopify/route.ts`.

Decision: accept five named operations, validate and clean variables, and execute server-owned GraphQL. Consequence: browser code never constructs arbitrary upstream operations or receives the configured token. Tradeoff: new Shopify cart capabilities need explicit handlers and contracts. Origin filtering and per-instance counters do not constitute customer authentication or distributed rate protection.

## 005 Built-in catalog fallback

Status: implemented; production policy decided 14 October 2026. Sources: `lib/catalog.ts`, `lib/shopify.ts`, `components/product/product-card.tsx`, `app/error.tsx`, `components/cart/cart-provider.tsx`.

Decision: outside production (`VERCEL_ENV` not `production`), serve demonstration products on missing configuration or catalog failure and use a local bag. On the production deployment, `getProducts` returns no products with `unavailable: true` (grids show "The store is temporarily unavailable") and `getProduct` throws `StorefrontError`, rendered by `app/error.tsx`. Consequence: useful local preview without Shopify, and no placeholder merchandise or prices on chaanavya.in. Tradeoff: a production outage hides the catalogue entirely; independent reads can still disagree about `live` during a partial failure.

## 006 Browser-local wishlist and cart reference

Status: implemented. Sources: `components/product/wishlist-button.tsx`, `components/cart/cart-provider.tsx`.

Decision: persist wishlist handles, demo lines, and a live cart reference in local storage. Consequence: continuity on the same browser without customer accounts. Tradeoff: no account portability, storage can fail, and live cart state does not synchronize across tabs. Full cart IDs require redaction.

## 007 Heuristic storefront collections

Status: implemented with known limits. Source: `lib/collections.ts`.

Decision: demo products use explicit collection lists; live products match title/type/tags. Untagged new arrivals can use the first eight newest loaded products. Consequence: pages work without fetching Shopify collection nodes. Tradeoff: false matches and differences from Shopify taxonomy are possible; only 50 products are loaded.

## 008 Customer contact, tracking and newsletter

Status: contact and tracking revised 14 October 2026; newsletter removed the same day. Sources: `app/contact/page.tsx`, `app/track-order/page.tsx`, `components/site/support.tsx`.

Decision: replace the preview contact and tracking forms with direct links. Contact links to the owner-confirmed email and WhatsApp; Track order links to Shopify new customer accounts (`ORDER_ACCOUNT_URL`), where customers sign in with their checkout email. The preview newsletter form was removed at the owner's request until an email service is chosen. Alternatives considered: a custom order lookup by order number and email (rejected: needs Admin API access on the server and risks exposing order data on a guessable reference). Consequence: no customer data passes through this app for support or tracking. Tradeoff: tracking depends on Shopify customer accounts staying enabled; there is no way to subscribe shoppers yet.

## 010 Welcome popup saves signups to Shopify customers

Status: implemented 14 October 2026; inactive in production until Shopify Admin credentials (`SHOPIFY_ADMIN_CLIENT_ID`/`SHOPIFY_ADMIN_CLIENT_SECRET`) are configured. Sources: `components/marketing/welcome-popup.tsx`, `lib/marketing/welcome-popup.ts`, `lib/marketing/newsletter.ts`, `app/api/marketing/subscribe/route.ts`.

Decision: use Shopify itself as the newsletter list (customer email-marketing consent, reachable from Shopify Email) instead of adding a provider. The popup shows 5 seconds after load on home, collection and product pages only, never over another open dialog or sheet, at most once per page load; closing suppresses it for 30 days and a confirmed signup for 180 days (versioned localStorage keys, memory fallback). Copy makes no offer claims because no welcome discount exists. Consent is an unchecked checkbox with versioned wording. Alternatives considered: posting to the Online Store theme's customer form (rejected: no reliable acknowledgement, captcha). Consequence: no new vendor; signups appear in Shopify Customers. Tradeoff: needs Admin API credentials with customer write access on the server; single opt-in is used, so confirm that matches the store's marketing settings.

## 011 Google Analytics loads only after cookie consent

Status: implemented 14 October 2026; inactive in production until `NEXT_PUBLIC_GA_MEASUREMENT_ID` is configured. Sources: `components/consent/cookie-consent.tsx`, `lib/consent.ts`, `proxy.ts`.

Decision: GA4 is the only tracker. A non-modal bottom banner offers Reject and Accept with equal weight; nothing beyond essential storage runs until Accept. The choice is a first-party cookie (`chaanavya_consent`, versioned, 180 days) and can be changed from "Cookie settings" in the footer; Reject also deletes `_ga` cookies. gtag.js is created by the client bundle after consent instead of an inline or always-loaded tag, so the strict nonce CSP needs only host allowances, added when an ID is configured. Ads consent signals stay denied. The welcome popup waits until the banner is answered so the two never stack. Alternatives considered: Google Consent Mode with the tag always loaded (rejected: sends cookieless pings before consent), Shopify's customer privacy banner (rejected: covers the Shopify-hosted pages, not this Next.js storefront). Tradeoff: no measurement for visitors who ignore or reject the banner. Bump `CONSENT_VERSION` in `lib/consent.ts` when adding a tracker or changing the wording.

## New decision record

For a significant future change record: date, status, problem, decision, alternatives actually considered, reason, consequences, affected files/contracts, and verification. Use proposed status until the decision is made; do not fabricate owner approval.
