# Stage 03 evidence: local development, environments, CI and secrets

Captured 15 October 2026 in the upgrade workspace `backup/upgrade` (copy of main 7347829; main is 60ea71a). Stage 03 was started, interrupted by Stage 04, and finished afterwards; these results are from after both, so they cover the Stage 04 additions too.

## Deliverables

| Checklist item | Delivered |
| --- | --- |
| 1 Node and npm versions | `.nvmrc` (24), `engines` node `>=22.18`, npm `>=10`; Next.js 16.4.0 and React 19.3.0 unchanged |
| 2 Local PostgreSQL, isolated environments | `compose.yaml` (Postgres 17.6, `127.0.0.1:54329`, development-only credentials); `lib/config/env.ts` (development, staging, production rules); `docs/operations/environments.md` |
| 3 Secret handling, env validation, test/live switches | `lib/config/env.ts`, `npm run check:env`, `.env.example` (planned settings, no values); `NEXT_PUBLIC_` guard; `docs/operations/secrets.md` |
| 4 CI | `.github/workflows/ci.yml`: install, lint, typecheck, unit tests, build, config check, secret scan; database job (restore check, migrations and integration tests); manual per-environment config check. Actions pinned to commit SHAs |
| 5 Structured errors, correlation IDs, redaction | `lib/observability/logger.ts` (JSON lines, correlation IDs, PAN/CVV/OTP/token/signature/address/email/phone/cart-key redaction) |
| 6 Staging, backups, restore | Staging defined as a proposal (`docs/operations/environments.md`); provider backup requirements (`docs/operations/database.md`); local backup/restore scripts (`scripts/db.mjs`) tested |
| 7 Runbooks | `docs/operations/`: bootstrap, environments, secrets, database (backups, migrations, rollback), deployments (ship, stop, roll back) |

## Results

| File | Result |
| --- | --- |
| fresh-setup-app.log | CHV-S03-001 app part: clean clone, every README step in PowerShell (`npm ci`, copy env, `check:env`, lint, typecheck, `npm test` 66/66, build, start: pages 200, unknown 404). All exit 0 |
| fresh-setup-db.log | CHV-S03-001 database part: new empty volume (0 tables), `db:up`, `db:migrate`, `db:seed:synthetic`, `db:migrate:status` up to date, `test:db` 46/46, `db:restore-check`; scratch volume removed. All exit 0 |
| check-env.log | CHV-S03-002: missing production storefront token refused (exit 1); live key and live mode in staging refused (exit 1); secret in a `NEXT_PUBLIC_` name refused (exit 1); empty development passes; this machine's `.env.local` passes, printed as names and set/missing only |
| unit-test.log | `npm test`: 66/66, including 18 environment tests and 14 logger tests |
| secret-scan.log | CHV-S03-003: `.next` and `evidence/` (1,044 files) contain none of the secret values in `.env.local` and none of 7 key patterns. Positive control: a planted fake live key and a planted secret value are both found (exit 1) |
| db-restore-check.log | CHV-S03-004: synthetic rows identical after backup and restore; restoring over `chaanavya_dev` refused; a one-paisa change produces a different fingerprint |
| ci-workflow.log | Workflow parses; 3 jobs; actions pinned; every referenced npm script exists |

## Test case status

| Case | Status |
| --- | --- |
| CHV-S03-001 fresh setup from README on a clean machine | Pass on a clean clone on this Windows machine. Not repeated on a second physical machine or on macOS/Linux |
| CHV-S03-002 CI refuses a missing required server secret in the targeted environment | Pass for the check that CI runs (`check:env`, CLI exit 1). The GitHub workflow itself has not run |
| CHV-S03-003 logs and build outputs contain no actual test API secrets | Pass for this build and these logs, with a positive control. Only two secret values exist locally (no Razorpay or database secrets yet) |
| CHV-S03-004 backup restore recovers seeded development data | Pass, with a negative control |

## Fixed while finishing

- The first restore check seeded its table into `chaanavya_dev`. On a clean machine that would make the later `db:migrate` fail (P3005: schema not empty). It now uses its own scratch databases; `npm run db:seed` was removed. My synthetic `dev_seed_check` table was dropped from the local `chaanavya_dev`, which was then migrated and seeded with the Prisma fixtures.
- The phone-number redaction could match inside longer digit runs (for example timestamps); it is now anchored.
- `README.md` local setup now covers Node 24, `check:env`, `npm test`, the local database, and the development warning about Shopify Admin credentials.

## Definition of done

- One documented clean local setup: yes (README plus `docs/operations/bootstrap.md`, tested from a clean clone).
- CI green for agreed baseline: every CI command passes locally; the workflow has never run on GitHub.
- Separated test/live config proven: yes, by tests and CLI runs with synthetic values.
- Backup and rollback instructions tested: local backup, restore and migration rollback yes; staging and production no (no database exists).

## Hand-off: still open

1. Run the CI workflow on GitHub once the workspace is copied back and pushed; fix anything that differs from local results.
2. Choose a database provider; create staging (Vercel environment, database, GitHub environment) per `docs/operations/environments.md`; then the provider backup and monthly restore drill.
3. Verify Vercel access for this team (API returned 403) and the project's Node version before deploying `engines >=22.18` and `postinstall: prisma generate`.
4. The logger is not yet used by the existing Shopify routes; new modules should use it, and the existing routes switch when they are rewritten.
5. Name a reviewer and an on-call or rollback owner (`docs/operations/README.md`).
6. Decision 012 (Shopify independence) still proposed.
