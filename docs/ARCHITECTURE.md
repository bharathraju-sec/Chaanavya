# Chaanavya Architecture

## System overview

The application is one Next.js App Router storefront with server-rendered pages and client components for interactive controls. Shopify supplies commerce data and hosted checkout. A same-origin route handler mediates browser cart operations. There is no separate backend service, ORM, or application database.

```text
Browser
  | GET storefront pages
  v
Next.js proxy -> App Router server components -> lib/shopify.ts -> Shopify Storefront GraphQL
  |                     |
  | CSP nonce           | normalized catalog and live status
  v                     v
Rendered pages + React client controls
  |
  | POST /api/shopify (allowlisted cart action)
  v
Route validation -> lib/shopify.ts -> Shopify cart
  |
  v
Bag state + returned checkout URL -> Shopify-hosted checkout
```

## Stack from package configuration

| Layer | Configuration |
| --- | --- |
| Framework | Next.js `16.4.0` |
| UI runtime | React and React DOM `19.3.0` |
| Language | TypeScript, strict mode, `@/*` root alias |
| Styling | Tailwind CSS 4, `tw-animate-css`, shadcn styles |
| Primitives | Radix UI, local shadcn components |
| Icons and notifications | Lucide React and Sonner |
| Commerce | Shopify Storefront GraphQL via native fetch |
| Hosting configuration | `vercel.json` declares Next.js |
| Checks | ESLint 9, Next.js ESLint configuration, TypeScript |

Versions are repository declarations, not a recommendation to upgrade or a statement about current vendor releases. `next-themes` is installed, but the design master specifies no dark mode.

## Project structure

```text
app/                    Routes, metadata, layout, global styles
  api/shopify/          Cart route handler
  [collection]/         Five configured collection pages
  products/[handle]/    Product details
components/
  cart/                 Cart context and bag Sheet
  product/              Cards, quick add, option selection, wishlist
  site/                 Header, footer, search, forms, editorial and support layouts
  ui/                   Shared Radix/shadcn primitives
lib/                    Shopify access, catalog fallback, collection rules, types, utilities
public/assets/          Logo, icons, social image, and fragrance artwork
design-system/          Existing visual master
docs/                   Product and engineering documentation
proxy.ts                Page CSP nonce
next.config.ts          Headers, image hosts, CSS loader, legacy redirects
```

## Responsibilities and boundaries

- `lib/shopify.ts` reads environment configuration, constructs upstream queries, normalizes products, and handles catalog fallback. Keep it on the server; the current boundary is a code convention, not a `server-only` import guard.
- `app/api/shopify/route.ts` validates browser requests and permits only the five defined cart actions. Never turn it into an arbitrary GraphQL relay.
- Root layout loads products for search and passes `live` to `CartProvider`. Pages fetch the relevant products independently.
- `CartProvider` owns interactive bag state. Product components call its methods rather than handling Shopify credentials.
- `lib/collections.ts` owns storefront category copy and filtering, not Shopify collection administration.
- There is no newsletter form (removed 14 October 2026). Contact and Track order are static pages that link to email, WhatsApp (`wa.me`) and Shopify customer accounts; they handle no customer data.

## Rendering and caching

`RootLayout` calls `connection()` to render pages per request so the proxy can issue a fresh script nonce. Component caching and partial prerendering are intentionally not enabled. `generateStaticParams` enumerates collection slugs and `dynamicParams=false` restricts that route; it does not make the root layout statically rendered.

Catalog fetches use `force-cache`, a 300-second revalidation period, and the `catalog` tag. Cart fetches use `no-store`; local API responses also send `Cache-Control: no-store`. No webhook or explicit catalog-tag invalidation endpoint exists.

Upstream operations time out after eight seconds. Products are requested newest first, up to 50; individual products include up to eight images, three options, and 30 variants. Cart responses request the first 100 lines. There is no cursor pagination.

## Data flow

Catalog: server fetch -> normalize nested Shopify nodes -> `Product` -> cards/details/search entries.

Purchase: option selection -> variant GID -> context method -> same-origin validated action -> Shopify mutation -> updated cart -> bag UI -> checkout URL.

Fallback: missing configuration or catalog error -> `fallbackProducts` and `live:false` outside production; on the production deployment -> no products, `unavailable:true`, and a store-unavailable message (product pages throw to `app/error.tsx`). Demo products and cart lines never constitute authoritative live inventory or prices.

## Failure and consistency risks

Root layout and product-page reads can produce different `live` results in a partial failure. The provider can then operate in a mode inconsistent with the visible product. Production never falls back to demo products. Live category membership is heuristic and can differ from Shopify collections. See `ERROR_HANDLING.md` and `ROADMAP.md`.

## Performance and change rules

Preserve image aspect ratios, `next/image` sizing, and selective priority loading. Measure page and Shopify latency before changing rendering or cache policy. When scaling past current limits, add explicit pagination and collection contracts rather than silently truncating data. Architecture changes should include a decision record, relevant contract updates, and end-to-end validation.
