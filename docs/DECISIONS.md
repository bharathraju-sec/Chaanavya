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

## New decision record

## 009 AI shopping assistant boundary

Status: implemented; production enablement requires owner review. Sources: `app/api/chat/route.ts`, `components/site/chat-assistant.tsx`, `.env.example`.

Decision: use Vercel AI Gateway from a same-origin server route for shopping help; provide only live catalog context, and keep chat transcripts out of app persistence. Order-status questions link to Shopify customer accounts; human support links open email or WhatsApp. Consequence: useful discovery and FAQ help without introducing customer authentication or an order-data endpoint. Tradeoff: shopper messages are processed by the configured AI Gateway/model provider, recommendation quality depends on current catalog context, and per-instance rate limiting is not distributed. Confirm provider terms, retention, privacy disclosure, production credentials, and host-wide rate controls before production enablement. Common-value redaction is best-effort only. The launcher is rendered only when `AI_GATEWAY_API_KEY` is set, or in local development (`NODE_ENV=development`) so the UI can be reviewed without a key; production without a key shows no chat at all.

For a significant future change record: date, status, problem, decision, alternatives actually considered, reason, consequences, affected files/contracts, and verification. Use proposed status until the decision is made; do not fabricate owner approval.
