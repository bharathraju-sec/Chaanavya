# Chaanavya Environment Configuration

## Configuration inventory

Application-controlled variables come from `.env.example` and `lib/shopify.ts`. None use a `NEXT_PUBLIC_` prefix.

| Variable | Required | Current use |
| --- | --- | --- |
| `SHOPIFY_STORE_DOMAIN` | For configured Shopify mode | Hostname for the Storefront endpoint; example names the project's Shopify host |
| `SHOPIFY_STOREFRONT_ACCESS_TOKEN` | For configured Shopify mode | Server-side `X-Shopify-Storefront-Access-Token`; blank in example |
| `SHOPIFY_STOREFRONT_API_VERSION` | Optional | Defaults to `2026-10`; accepts `YYYY-MM` or `unstable` format |
| `SHOPIFY_USE_MOCK` | Optional | Exact string `true` selects external mock when `VERCEL_ENV` is not `production`; example is false |
| `VERCEL_ENV` | Platform supplied on Vercel | Used by the mock guard; do not forge it to bypass production restrictions |
| `NODE_ENV` | Runtime supplied | Development-only CSP allowances; not used by the current mock guard |

API-version syntax validation does not prove that the selected version supports the queried fields. Verify compatibility with the actual store before release.

## Local setup

Use Node.js meeting `package.json`'s `>=20.9` requirement. Install through npm and the checked-in lockfile.

```powershell
npm ci
```

If `.env.local` does not already exist:

```powershell
Copy-Item .env.example .env.local
```

Fill the token privately, retain `SHOPIFY_USE_MOCK=false` for real store testing, and restart the dev server after changing configuration.

```powershell
npm run dev
```

Use the URL printed by Next.js; its normal development port is 3000 unless overridden or occupied. `npm run build` creates the production build; `npm run start` serves it. Font loading uses `next/font/google`, so a build may need access to its font source.

## Modes

| Mode | Trigger | Catalog and checkout |
| --- | --- | --- |
| Built-in fallback | No valid store configuration, or catalog read fails, and `VERCEL_ENV` is not `production` | Static demonstration catalog; root layout normally sets `live:false`; local demo bag and disabled checkout. On production: store-unavailable message instead |
| Configured Shopify | Domain and token supplied with mock off | Storefront queries; successful root catalog read sets `live:true` and enables Shopify cart operations |
| External mock | Mock true and Vercel environment not production | Endpoint `https://mock.shop/api/<version>/graphql.json`; successful reads can set `live:true` |

Fallback is not the same as external mock mode. `live` is a read result, not proof of real production commerce. A catalog failure can switch the provider to demo behavior; independent page reads can disagree. See `ERROR_HANDLING.md`.

Important current limitation: mock mode is blocked by `VERCEL_ENV=production` only. A local production build or another host with no `VERCEL_ENV` can still select mock mode. Keep mock false for all production deployments and strengthen the guard before supporting additional hosts.

## Hosting and domains

`vercel.json` declares Next.js. `app/layout.tsx` uses `https://chaanavya.in` as `metadataBase`; it is not configurable through an environment variable today. Domain routing, ownership, DNS, TLS, production credentials, and deployment status were not inspected by this documentation task.

Define development, preview, and production credentials in their appropriate hosting scopes. Use controlled store data for preview testing and confirm no preview points to a real purchase flow unintentionally. Environment changes require a new deployment or process restart as appropriate.

## Secret rules

`.env.local` and other environment files are ignored. `.env.example` is the safe tracked exception. `.vercel` contains local hosting linkage and is ignored; do not publish it. Keep tokens private, do not capture them in screenshots or command output, and rotate confirmed exposed credentials.

## Unconfigured services

No environment variables or clients exist for contact delivery, newsletter subscriptions, order tracking, analytics, error tracking, a custom database, or a direct Razorpay integration. Add configuration documentation when an integration is actually chosen and implemented.

## Newsletter signup

`SHOPIFY_ADMIN_CLIENT_ID` and `SHOPIFY_ADMIN_CLIENT_SECRET` (server only): credentials of a Shopify Dev Dashboard app with `write_customers` and `read_customers` scopes, installed on this store. The server exchanges them for a 24-hour Admin API token (client credentials grant, `https://<store>.myshopify.com/admin/oauth/access_token`) and reuses it per function instance. `SHOPIFY_ADMIN_ACCESS_TOKEN` is accepted instead for a legacy custom app with a permanent token. Used only by `POST /api/marketing/subscribe`. When none are set, the endpoint returns 503 and the welcome popup is not rendered in production (local development still shows it, and submissions report "not available yet"). Never prefix these with `NEXT_PUBLIC_`.

## Analytics and cookie consent

`NEXT_PUBLIC_GA_MEASUREMENT_ID` (public, inlined at build time): Google Analytics 4 Measurement ID, format `G-XXXXXXXXXX`, from Google Analytics > Admin > Data streams > Web. When set, the cookie banner appears in production, the CSP allows Google Analytics hosts, and GA loads only for visitors who press Accept. When absent, no banner shows in production and no analytics runs (local development still shows the banner for review). Changing it requires a redeploy.
