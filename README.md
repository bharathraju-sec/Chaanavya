# Chaanavya Storefront

Chaanavya is a women's fashion storefront: a Next.js App Router web host (storefront and admin pages), a NestJS API (`apps/api`) that owns PostgreSQL (Prisma), Better Auth sign-in and the admin rules, and a worker (`apps/worker`) for scheduled jobs. The web host forwards `/api/*` to the API. It shows a placeholder catalogue (template products and prices) with variant selection and a shopping bag kept in the browser; online checkout is not open yet. Customers sign in or sign up with an emailed code, and staff use a separate admin workspace with two-factor sign-in. A cookie banner gates Google Analytics.

## Local setup

Use Node.js 24 (`.nvmrc`; 22.18 or newer works) and npm 10 or newer with the checked-in lockfile. Docker is needed only for the local database.

```powershell
npm ci
if (-not (Test-Path .env.local)) { Copy-Item .env.example .env.local }
npm run check:env
npm run dev
```

`npm ci` also generates the database client (`postinstall`). The setup command preserves an existing `.env.local`. Enter credentials privately in that local file and restart the development server after configuration changes. The storefront shows the placeholder catalogue and keeps checkout closed. `.env.example` lists every setting. `npm run check:env` validates them and prints names only, never values.

Sign-in and the admin need the local database (below) and the API running beside the web host:

```powershell
npm run dev:api      # API on http://127.0.0.1:4000, rebuilds on change
npm run dev:worker   # optional: scheduled jobs
```

In development, sign-in codes are printed in the API's console because no email provider is connected yet. Sign-in also needs `BETTER_AUTH_SECRET` in `.env.local`.

```powershell
npm run lint
npm run typecheck
npm test
npm run build
npm run start
```

`npm test` runs unit tests for the planned commerce contracts, the environment check and the logger (Node's built-in runner). They do not exercise the storefront. Lint, type checking, tests, and build success do not verify checkout or customer journeys; test those journeys manually.

### Local database

Sign-in, customer accounts and the admin keep their data here:

```powershell
npm run db:up
npm run db:migrate
npm run db:seed:synthetic
npm run test:db
```

`db:up` starts PostgreSQL 17 in Docker on `127.0.0.1:15432` with development-only credentials (`compose.yaml`). `npm run db:restore-check` backs up and restores the development database to prove recovery works. See [apps/api/prisma/README.md](apps/api/prisma/README.md) for schema changes. `docker compose --profile services up --build -d` runs the API and worker in containers.

## Project documentation

Detailed project documentation (requirements, architecture, API, environment, testing, deployment and decisions) is kept in a local `docs/` folder that is intentionally not versioned in git or deployed. Coding agents should read [AGENTS.md](AGENTS.md).

The [design master](design-system/chaanavya/MASTER.md) remains the visual authority.

## Launch status

Source inspection establishes the implemented features, not live store readiness. The catalog, policies, brand positioning, payment provider, support channels, and hosting controls still need verification before release.
