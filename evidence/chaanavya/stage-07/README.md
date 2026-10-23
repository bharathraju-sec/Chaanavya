# Stage 07 evidence: dedicated NestJS API and service migration

Captured 16 October 2026 in the upgrade workspace `backup/upgrade` (based on main `60ea71a`, which is untouched). No implementation commit exists yet: the workspace is copied back to main by the owner. Decision 032.

## Deliverables

| Path | Contents |
| --- | --- |
| `apps/api/` | NestJS 12.1 API: `/api/v1` controllers (session, account, orders, admin), Better Auth at `/api/auth`, `/health` and `/ready`, internal-key check, request context with correlation IDs, body reader, error envelopes, global access guard (fails closed), per-IP throttle, OpenAPI generation |
| `apps/api/prisma/`, `apps/api/src/db/` | Prisma schema, migrations (unchanged, moved from `prisma/`), rollback scripts, roles, seed; client with `DATABASE_POOL_MAX` |
| `apps/api/src/auth/`, `src/admin/`, `src/audit/` | Moved from `lib/`: Better Auth server, sessions and permissions (now Nest guards), staff changes with audit, admin helpers, audit catalogue |
| `apps/worker/` | Advisory-locked job runner, auth housekeeping job, `/health` and `/ready`, clean shutdown |
| `packages/shared/`, `packages/contracts/` | Environment check (with service scopes), logger, admin host rules, RBAC, money display; Stage 02 contracts, OpenAPI document and generated types |
| `app/api/[...path]/route.ts`, `lib/api/` | Web forwarder (decision 032) and typed page reads |
| Admin and account pages | Read through the API; the settings page shows API and web host configuration separately |
| `docker/services.Dockerfile`, `.dockerignore`, `compose.yaml`, `.github/workflows/ci.yml` | Images, Compose services (`--profile services`), CI job for the API, images and OpenAPI drift |
| `scripts/parity-diff.mjs`, `tests/security/api/service.test.mjs`, `tests/integration/database/worker.test.mjs` | Parity comparison and the new Stage 07 tests |

## Required tests

| ID | Requirement | Where | Result |
| --- | --- | --- | --- |
| CHV-S07-001 | API starts independently; readiness reflects database connectivity | `service.test.mjs` "the API starts on its own" (3 tests: probes, 503 with the database unreachable, refusal to start with incomplete production configuration); `containers.log` (images against a throwaway database) | Pass |
| CHV-S07-002 | Customer and owner account flows still work, including TOTP, logout and revocation | `mfa.test.mjs` (7), `tokens.test.mjs` (9), `abuse-and-claim.test.mjs` (12), all through the forwarder against the API; `admin-pages.test.mjs` owner sign-in with TOTP on the admin host against the API process | Pass |
| CHV-S07-003 | Admin mutations enforce actor role, reason, ETag and canonical audit in one transaction | `admin-api.test.mjs` "staff limits", "canonical audit events", "API patterns" (12 tests) against the API | Pass |
| CHV-S07-004 | Cross-origin, cookie and CSRF tests block unauthorised operations; the shop host cannot reach admin APIs | `admin-access.test.mjs` "request protections" and static checks, `admin-api.test.mjs` "admin on its own host", `guest-isolation.test.mjs`, `service.test.mjs` "only the web host can call the API" (no key, wrong key, no CORS) | Pass |
| CHV-S07-005 | Stage 01 to 06 regression and database suites pass against the new boundary | `unit.log` 70/70, `database.log` 48/48, `security-nest-api.log` 72/72, `e2e-pages.log` 14/14; parity 268 of 270 identical | Pass |

## Results

| File | Command | Result |
| --- | --- | --- |
| `baseline-security-next.log` | `npm run test:security` before the move, against the Next.js handlers | 63 of 63 pass |
| `security-nest-api.log` | `npm run test:security` (builds the API first) | 72 of 72 pass (63 earlier tests plus the forwarder-only static check and 8 service tests) |
| `unit.log` | `npm test` | 70 of 70 pass (3 new service-scope checks) |
| `database.log` | `npm run test:db` | 48 of 48 pass (2 new worker tests) |
| `e2e-pages.log` | `npm run test:e2e` with the API as its own process and `next start` | 14 of 14 pass; the web process had no `DATABASE_URL` or `BETTER_AUTH_SECRET` |
| `parity/next-handlers/`, `parity/nest-api/`, `parity-diff.log` | `PARITY_RECORD=<dir>` security runs, `node scripts/parity-diff.mjs ... --allow /api/admin/settings --allow /api/admin/audit` | 268 of 270 normalised responses identical; the 2 differences are intended (below) |
| `lint-typecheck.log` | `npm run lint && npm run typecheck` (web, API, worker) | Clean |
| `build.log` | `npm run build` | Compiled successfully |
| `worker-run.log` | Worker process against a throwaway database | `/health` 200, `/ready` 200 with one successful housekeeping run, unknown path 404 |
| `containers.log`, `images.log` | `docker build -f docker/services.Dockerfile --target api|worker .`, both images run against a throwaway database | Both build; API `/health` 200, `/ready` 200, 401 without key, 200 with key; worker ready; both stop on `docker stop` |
| `secret-scan.log` | `npm run scan:secrets -- --env-file .env.local .next evidence apps/api/dist packages` | No secrets found |

Intended parity differences: `GET /api/admin/settings` now lists the API's own settings, each with the services that use it; access-denied audit events name the API path (`/api/v1/admin/...`) that refused the call instead of the browser path.

OpenAPI: `npm run api:openapi` regenerates `packages/contracts/openapi/api.json` (13 paths) byte for byte; CI fails when it drifts.

## Not verified

- Graceful worker shutdown on SIGTERM on Windows (Node cannot deliver SIGTERM there); in the Linux container `docker stop` ended both services within the timeout.
- No browser session check of the admin pages: as in Stage 06, the pages were verified over HTTP by the page tests.
- No staging or production deployment: where the API and worker are hosted is not decided.

## Open items for the owner

1. Choose where the API and worker run (a container host with private database access, close to the database) and the API's address for `API_URL`. Vercel keeps the web host.
2. Generate `API_INTERNAL_KEY` for staging and production and store it on both the web host and the API; remove `DATABASE_URL` and `BETTER_AUTH_SECRET` from the Vercel project when deploying.
3. Local sign-in needs `BETTER_AUTH_SECRET` in `.env.local` (it has none today).
4. The images are 1.35 GB because the runtime keeps every workspace's production packages, including Next.js; trimming them is a follow-up.
5. Still open from Stage 06: admin domain spelling, refund threshold (decision 030), placeholder catalogue before deployment (decision 031), legal review, email provider.
6. Reviewer for Stage 07: unassigned.
