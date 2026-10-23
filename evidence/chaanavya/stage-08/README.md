# Stage 08 evidence: product, collection, variant and media administration

Captured 16 October 2026 in the upgrade workspace `backup/upgrade` (based on main `60ea71a`, which is untouched; no implementation commit yet, the owner copies the workspace back to main). Decisions 033 and 034; design in `docs/architecture/catalogue.md`.

The shop still shows the placeholder catalogue from `lib/catalog.ts`. No real product was created: every product in these tests and the UI check is a test fixture in a throwaway database. Approved real listings remain a business prerequisite.

## Deliverables

| Path | Contents |
| --- | --- |
| `apps/api/prisma/migrations/20261016000000_catalogue_admin/`, `rollback/...down.sql` | Additive migration: product versions and publish approval, shipping restriction, photo review state, upload intents, outbox, the four storefront categories, storefront-category trigger, order line snapshot trigger |
| `apps/api/src/catalogue/` | Rules and publish checks, products and variant matrix, collections, public reads, CSV import and export |
| `apps/api/src/media/` | S3 storage (signed uploads, copy to public, signed previews), upload intents and verification |
| `apps/api/src/outbox/`, `apps/worker/src/jobs/outbox.ts`, `media-cleanup.ts` | Transactional outbox and its delivery job; photo deletion policy |
| `apps/api/src/modules/catalogue.controller.ts`, `storefront.controller.ts` | 17 admin and 3 public API paths (OpenAPI now 33 paths) |
| `app/admin/(workspace)/products/` and `components/admin/catalogue/` | Product list, new product, editor (details, variant matrix, photos, publishing), draft preview, collections, CSV import |
| `packages/shared/src/auth/rbac.ts`, `config/env.ts`, `media.ts`; `proxy.ts` | `catalogue.read` and `catalogue.publish`; photo storage settings; CSP for photo origins |
| `compose.yaml` | `media` service (S3Mock 4.10.0) for local photo storage |

## Required tests

| ID | Requirement | Where | Result |
| --- | --- | --- | --- |
| CHV-S08-001 | Non-admin and unauthorised staff cannot create, edit or publish | `tests/security/catalogue/catalogue.test.mjs` "only the right staff" (7 tests: visitor 401 and customer 403 on every route, STAFF read-only, ADMIN cannot publish, approve or edit live, reason/ETag/checklist required, publish checks, synthetic never published, handle fixed once live); page tests for STAFF and customers | Pass |
| CHV-S08-002 | Duplicate SKUs and option collisions rejected without partial writes | "SKU and option clashes" (5 tests: duplicates in one save, clash with another product leaves every row and the version untouched, swaps and archive/re-add, stale ETag, stock untouched); CSV preview errors; unit tests for the rules | Pass |
| CHV-S08-003 | Drafts, unapproved products and pending images hidden from public queries | "nothing unapproved reaches public reads" (5 tests: draft, archived and unknown handles are the same 404; pending and rejected photos never public; hidden collections; outbox only for live changes, handles only; storefront categories keep their URLs) | Pass |
| CHV-S08-004 | Upload abuse, unsupported media and unauthorised signed operations rejected | "upload abuse is refused" (5 tests: unsupported types, size, checksum format; signed headers fix type, length and checksum, 10-minute expiry, staging path, storage refuses other bytes; SVG/HTML posing as PNG, wrong type, tiny, truncated and appended files refused and deleted; intents owned by their creator, single use, expiring; approve/reject need `catalogue.publish`; open-intent limit) | Pass |
| CHV-S08-005 | Editing prices never mutates historical order snapshots | "price edits never change order snapshots" (2 tests: live reprice with reason is audited and leaves the order line byte for byte; the database trigger refuses any snapshot change) | Pass |

## Results

| File | Command | Result |
| --- | --- | --- |
| `unit.log` | `npm test` | 86 of 86 pass (15 new catalogue rule, CSV and photo-check tests; 1 new settings test) |
| `database.log` | `npm run test:db` | 50 of 50 pass (2 new worker job tests; every rollback script including Stage 08, then re-migration) |
| `security.log` | `npm run test:security` | 99 of 99 pass (27 new catalogue tests against the API and the S3Mock store) |
| `e2e-pages.log` | `npm run test:e2e` (API process and `next start`) | 18 of 18 pass (4 new product page tests) |
| `parity/`, `parity-diff.log` | Stage 05 to 07 security runs recorded and compared with Stage 07 | 263 of 270 identical; the rest are intended: `/admin/me` lists the new catalogue capabilities, settings list the photo storage settings, and one audit entry differs only by a random ID |
| `lint-typecheck.log` | `npm run lint && npm run typecheck` | Clean |
| `build.log` | `npm run build` | Compiled successfully |
| `images.log` | `docker build -f docker/services.Dockerfile --target api|worker .` | Both build |
| `secret-scan.log` | `npm run scan:secrets -- --env-file .env.local .next evidence apps/api/dist packages` | No secrets found |

OpenAPI: `npm run api:openapi` reproduces the committed document byte for byte.

## Browser check (16 October 2026)

API and `next dev` on a throwaway database, signed in on the local admin as a test owner created for the check (credentials and database deleted afterwards).

- `editor-draft-1280.jpg`: a draft with three sizes, one approved and one waiting photo, and its two blockers.
- Set the shipping restriction, approved the waiting photo, added its alt text, confirmed the five checklist items and published with a reason: the product went live, its address locked and the live-change reason box appeared. The public API then returned it with its two approved photos from `public/products/...`.
- `editor-conflict.png`: a change made from a second request, then a save from the stale page: refused, with the Reload notice; nothing overwritten.
- `preview-375.jpg`: draft preview at 375 px; neither the preview nor the editor scrolls sideways at 375 px.
- Found and fixed: on a computer in dark mode, text areas took shadcn's dark tint. `dark:` styles now apply only under a `.dark` class (no dark mode, design master).
- Console: one error, the deliberate 412 from the conflict check.

## Not verified

- Real S3 or R2: S3Mock does not check signatures or permissions, so signature enforcement is shown by the signed headers only. Bucket policy and CORS are documented, not tested.
- Photo metadata (EXIF, GPS) is not stripped from stored originals.
- A missing product on the admin editor shows the "Nothing here" page with HTTP 200 because workspace pages stream (non-staff still get a real 404 from the layout); the admin host is never indexed.
- The outbox delivery handler only logs until Stage 10 adds the storefront cache refresh.

## Open items for the owner

1. Confirm decision 033: only the OWNER publishes, approves photos and edits live products.
2. Choose the photo storage provider and bucket (decision 034), and the public photo address (for example `media.chaanavya.in`).
3. Provide approved real listings: descriptions, prices, sizes, tax categories (with a tax advisor, decision 014) and photos. Nothing in the placeholder catalogue may be published.
4. Confirm the shipping restriction names for fragrance (liquid) and jewellery (high value); courier rules come in Stage 16.
5. Still open from earlier stages: API and worker hosting, `BETTER_AUTH_SECRET` in `.env.local` for local sign-in, admin domain spelling, refund threshold, placeholder catalogue before deployment, legal review, email provider.
6. Reviewer for Stage 08: unassigned.
