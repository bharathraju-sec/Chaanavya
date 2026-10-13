# Chaanavya Storefront

Chaanavya is a women's fashion storefront built with Next.js App Router, React, TypeScript, and Shopify Storefront GraphQL. It supports catalog browsing, variant selection, a shopping bag, and a handoff to Shopify checkout. Contact and order tracking link to email, WhatsApp and Shopify customer accounts. There is no newsletter sign-up yet.

## Local setup

Use Node.js 20.9 or newer, as required by `package.json`, and npm with the checked-in lockfile.

```powershell
npm ci
if (-not (Test-Path .env.local)) { Copy-Item .env.example .env.local }
npm run dev
```

The setup command preserves an existing `.env.local`. Enter credentials privately in that local file and restart the development server after configuration changes. Without Shopify configuration, the app uses a demonstration catalog and disables checkout. See [environment configuration](docs/ENVIRONMENT.md) for the distinct external mock mode.

```powershell
npm run lint
npm run typecheck
npm run build
npm run start
```

There is no automated test script or test suite checked in. Lint, type checking, and build success do not verify checkout or customer journeys; use the [testing checklist](docs/TESTING.md).

## Project documentation

Start with the [documentation index](docs/README.md), [product requirements](docs/PRD.md), and [architecture](docs/ARCHITECTURE.md). Coding agents should read [AGENTS.md](AGENTS.md).

The existing [design master](design-system/chaanavya/MASTER.md) remains the visual authority. [Design system documentation](docs/DESIGN_SYSTEM.md) explains how it maps to the implementation.

## Launch status

Source inspection establishes the implemented features, not live store readiness. The catalog, policies, brand positioning, payment provider, support channels, and hosting controls still need verification before release. See the [roadmap](docs/ROADMAP.md) and [deployment checklist](docs/DEPLOYMENT.md).
