# Stage 10 evidence: public catalogue and storefront (gate)

Captured 21 October 2026 in the upgrade workspace `backup/upgrade` (based on main `60ea71a`, untouched; no implementation commit yet). Design and behaviour: `docs/architecture/catalogue-read-interface.md`; decisions 032 to 035 still apply.

Gate (README of the stage pack): public pages serve published real catalogue data through NestJS; production checkout remains gated.

No real product, SKU or signed stocktake exists, so no real catalogue data was served. Every product in these tests and checks is a fixture in a throwaway database. The gate's first half is proven for the mechanism (what is published and counted is served, nothing else); serving the owner's real catalogue waits on the owner's real listings and first signed count.

## What each micro-stage delivered

| Stage | Test | What it shows | Evidence |
| --- | --- | --- | --- |
| 10.01 | CHV-S10-M01 | SKU, variant and unpublished item traced to their database rows | `10.01-trace.log` |
| 10.02 | CHV-S10-M02 | Public DTOs hold exactly the contract's fields; private fields never leave the API | `10.02-*.log` |
| 10.03 | CHV-S10-M03 | The list API called directly never returns drafts, unpublished, archived or uncounted products; forged cursors refused | `10.03-*.log` |
| 10.04 | CHV-S10-M04 | A published handle loads with the variant to show first; hidden handles read like missing ones | `10.04-*.log` |
| 10.05 | CHV-S10-M05 | A collection returns only its published members, newest first, in bounded pages | `10.05-*.log` |
| 10.06 | CHV-S10-M06 | The storefront reads only through the API; a process with no database settings works; failures become "unavailable" | `10.06-*.log` |
| 10.07 | CHV-S10-M07 | Homepage and search show API products with no sample fallback | `10.07-*.log` |
| 10.08 | CHV-S10-M08 | Collection pages show the right items, empty states, slugs and redirects | `10.08-*.log` |
| 10.09 | CHV-S10-M09 | Choosing a size shows that size's price and stock; canonical handles | `10.09-*.log` |
| 10.10 | CHV-S10-M10 | A publish, stock change or unpublish is visible after the worker's delivery; 60 second cache bound | `10.10-*.log` |
| 10.11 | CHV-S10-M11 | Sitemap, robots and indexing rules; every listed page opens; checkout stays closed | `10.11-*.log` |

## Gate results (10.11, final run)

| File | Command | Result |
| --- | --- | --- |
| `10.11-build.log` | `npm run build:all` | API, worker and web host compile |
| `10.11-gate.log` | `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/support/register.mjs --test tests/e2e/catalogue-gate.test.mjs` | 7 of 7 pass |
| `10.11-unit.log` | `npm test` | 95 of 95 pass |
| `10.11-database.log` | `npm run test:db` | 61 of 61 pass |
| `10.11-security.log` | `npm run test:security` | 149 of 149 pass |
| `10.11-e2e-pages.log` | `npm run test:e2e` | 47 of 47 pass (includes the Stage 10 page tests) |
| `10.11-typecheck.log`, `10.11-lint.log` | `npm run typecheck`, `npm run lint` | Clean |
| `10.11-secret-scan.log` | `npm run scan:secrets -- --process-env .next` | 1,444 files, no secrets |

Mutation checks (a test that cannot fail proves nothing): in 10.07 to 10.11 the production code was temporarily changed to the failure the test guards against (sample products on the homepage, collection and product pages; no cache expiry; the old static sitemap) and the matching tests failed each time; the code was restored and rebuilt.

## Browser check (21 October 2026)

A fixture product in a throwaway database, `next dev` on port 5670, phone width 375 px: home, collection, empty collection, product, size guide and terms have no sideways scroll; the viewport allows zoom; size buttons are 80 by 48 px; an empty collection is `noindex, follow`; canonical addresses are as listed. Choosing S, M, L showed 2,499, 2,699 with "Was 2,999", and L (sold out) cannot be chosen. The bag holds the item and its checkout control is a disabled "Checkout opens soon" button with no link. These browser checks were done by hand, not automated.

## Not verified

- No real catalogue, stock count or owner-approved listing exists.
- Checkout, payments and shipping are not built (Stages 11 to 14 and 16); the bag is a browser-only demo cart.
- Structured data, social images beyond the first photo and real collection copy are not done (owner decisions).
- No production host exists: `MEDIA_PUBLIC_BASE_URL` (web host), `WEB_URL` and `API_INTERNAL_KEY` (worker) and the API and worker hosting are not set anywhere.
- The first page load after starting the dev server showed broken product photos once (a 400 from the image route); a real reload fixed it. The cause was not found.

## Open items for the owner

1. Provide the real product sheet and do the first physical count (Stage 09 open item); until then the shop shows no products.
2. Decide whether structured data (price and availability markup for search engines) should be added once real prices exist.
3. Replace the template collection and page copy flagged in `design-system/chaanavya/MASTER.md`.
4. Reviewer for Stage 10: unassigned.
