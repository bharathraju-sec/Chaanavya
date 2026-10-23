# Stage 04 evidence: PostgreSQL schema, ORM and migrations

Captured 15 October 2026 in the upgrade workspace `backup/upgrade` (copy of main 7347829; main is 60ea71a). Local only: PostgreSQL 17.6 in Docker (`compose.yaml`, port 54329). No staging or production database exists, and the storefront does not import `lib/db` or Prisma.

## Deliverables

| Path | Contents |
| --- | --- |
| `prisma/schema.prisma` | 27 tables, 17 enums (values identical to Stage 02 state machines) |
| `prisma/migrations/20261015000000_init/` | Generated DDL plus hand-written sequence, CHECK constraints, partial unique SKU index, append-only triggers |
| `prisma/rollback/20261015000000_init.down.sql` | Rollback for rehearsal |
| `prisma/sql/roles.sql` | Least-privilege roles (migrator, app, read-only) |
| `prisma/seed.mjs` | Synthetic fixtures only; refuses staging and production |
| `prisma.config.ts`, `lib/db/client.ts` | Prisma 7 configuration and client (local compose default, `DATABASE_URL` required elsewhere) |
| `lib/db/money.ts`, `lib/db/transitions.ts` | bigint/number paise conversion; compare-and-set transitions with audit in one transaction |
| `tests/integration/database/` | 46 integration tests (`npm run test:db`) |
| `prisma/README.md`, `docs/architecture/database-schema.md`, decisions 020 to 024 | How to change the schema, contract review, retention proposal |
| `package.json` | Prisma 7.10.0 pinned; `postinstall: prisma generate`; `db:*` and `test:db` scripts; `npm test` now runs unit tests only |
| `tsconfig.json`, `eslint.config.mjs`, `.gitignore`, `.github/workflows/ci.yml` | `.ts` import extensions allowed; UI may not import `lib/db` or Prisma; generated client ignored; CI database job runs `test:db` |

## Results

| File | Result |
| --- | --- |
| db-test.log | `npm run test:db`: 46 tests, 46 pass, exit 0 |
| unit-test.log | `npm test`: 52 tests, 52 pass, exit 0 (Stage 02 contracts and Stage 03 environment checks) |
| lint.log, typecheck.log, build.log | all exit 0; build has the same 14 routes as before |
| secret-scan.log | `.next` and `evidence/` scanned for the secret values in `.env.local` and 7 credential patterns: none found |

One Stage 03 test (`env.test.mjs`, "reports contain names and statuses, never values") failed on its first run because it also searched for non-secret words such as `chaanavya`. The test was narrowed to credential values; no value had leaked.

## Test case status

| Case | Status | Test |
| --- | --- | --- |
| CHV-S04-001 empty DB migrates; duplicate active SKUs rejected | Pass | `schema.test.mjs` (also drift, 27 tables, constraints, append-only, enum parity) |
| CHV-S04-002 money precise without floats | Pass | `money.test.mjs` (max bigint round-trip, exact sums, fractions refused, totals CHECK) |
| CHV-S04-003 snapshots unchanged after product edits | Pass | `snapshot.test.mjs` (rename, reprice, re-SKU, archive, delete variant, address edit) |
| CHV-S04-004 rejected transaction rolls back stock and order writes | Pass | `transaction.test.mjs` (shortage, constraint failure, stale writer, failed audit) |

Definition of done: schema reviewed against Stage 02 contracts (`docs/architecture/database-schema.md`, reviewer still needed); seed and migration checks pass; constraints and indexes verified by tests; backup, restore and rollback rehearsal recorded (`rehearsal.test.mjs`).

## Hand-off: unresolved blockers for Stage 05

1. Decision 012 (Shopify independence) is still proposed; `docs/AGENTS.md`, `PRD.md` and `DATABASE.md` non-goals still forbid a local database. Owner approval needed.
2. No reviewer named for Stages 01 to 04.
3. Stage 03 is incomplete: logger tests, the fresh-setup check (CHV-S03-001), operations runbooks and the Stage 03 evidence index were not done when Stage 04 started. Its env checks (CHV-S03-002) and backup/restore check (CHV-S03-004) did pass.
4. No staging or production database provider chosen, so managed backups, point-in-time recovery and TLS settings are unverified.
5. Proposed decisions waiting on the owner or tax advisor: 014 (GST-inclusive prices), 016 (order number format), 024 (retention).
6. `postinstall: prisma generate` and `engines.node >=22.18` change the Vercel build when this workspace is copied back to main; check the Vercel Node version first.
7. The authentication library (Stage 05) may require changes to `user`, `role` and `session`.
