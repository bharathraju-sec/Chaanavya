# Stage 09 evidence: inventory ledger, reservations and real catalogue import

Captured 16 October 2026 in the upgrade workspace `backup/upgrade` (based on main `60ea71a`, untouched; no implementation commit yet). Decision 035; design in `docs/architecture/inventory.md`, runbook in `docs/migration/catalogue-reconciliation.md`.

No real product, stock count or Shopify export was available, so none was imported. Every product, count and file in these tests and the UI check is a test fixture in a throwaway database. The gate's last condition (approved real SKUs ready for display) waits on the owner's real listings and first physical stocktake.

## Deliverables

| Path | Contents |
| --- | --- |
| `apps/api/prisma/migrations/20261017000000_inventory_operations/`, rollback | Last-counted date and low-stock threshold per SKU, movement detail (reason code, balance after), stocktakes and lines, trigger locking signed stocktakes |
| `apps/api/src/inventory/ledger.ts` | The only code that changes a balance: conditional update plus append-only movement, idempotency keys |
| `apps/api/src/inventory/stock.ts` | Receive, correct, write off, thresholds; stock and movement views |
| `apps/api/src/inventory/reservations.ts` | All-or-nothing holds, exactly-once release and allocation, payment grace, late capture to review |
| `apps/api/src/inventory/stocktakes.ts` | Drafts, count-file and Shopify-export imports, reconciliation report, signed approval |
| `apps/api/src/modules/inventory.controller.ts` | 13 inventory API paths (OpenAPI now 46) |
| `apps/worker/src/jobs/reservation-expiry.ts`, `inventory-reconciliation.ts` | Workers (locks 7004, 7005) |
| `scripts/import/shopify-export.mjs` | Offline, read-only Shopify export converter (no Shopify code or network) |
| `app/admin/(workspace)/inventory/`, `components/admin/inventory/` | Stock list, SKU page with actions and history, stocktakes list, stocktake editor and approval |
| `apps/api/src/catalogue/public.ts` | Public reads gated on counted stock; `availableForSale` per variant |

## Required tests

| ID | Requirement | Where | Result |
| --- | --- | --- | --- |
| CHV-S09-001 | 100 concurrent requests for one unit cannot oversell | `tests/integration/database/inventory.test.mjs` "no overselling": 100 parallel holds, exactly 1 succeeds, 99 out of stock, one ledger row; multi-SKU all or nothing; uncounted SKUs never held; idempotent keys; bounded holds; database refuses negative balances | Pass |
| CHV-S09-002 | Expired or cancelled holds released exactly once; delayed payment handled safely | "holds end exactly once": ten racing settlers release once; cancelled order once; full capture allocates; authorised payment held through the grace period then released; capture after release sends the order to review without taking the unit someone else holds | Pass |
| CHV-S09-003 | Adjustment, ledger and audit commit or roll back together | `tests/security/inventory/inventory.test.mjs` "one unit": each change one movement with balance-after and one audit event; an over-large write-off and a failing audit step leave no movement, no audit and the same ETag; ledger and signed stocktakes cannot be edited | Pass |
| CHV-S09-004 | Repeat imports idempotent, discrepancies reported, demo goods never live | "imports are idempotent": the same file returns the same stocktake before and after approval, corrections applied once; Shopify export quantities are reference only; synthetic, placeholder and unknown SKUs refused; public reads hidden until counted | Pass |
| CHV-S09-005 | Stock consistent after a simulated worker failure and retry | "worker failure and retry": a crash after settling rolls back only that hold; retries release each hold exactly once; reconciliation finds no mismatch; a tampered balance is reported once and never auto-fixed | Pass |

## Results

| File | Command | Result |
| --- | --- | --- |
| `unit.log` | `npm test` | 88 of 88 pass (2 new: Shopify converter) |
| `database.log` | `npm run test:db` | 61 of 61 pass (11 new inventory tests; every rollback script including Stage 09, then re-migration) |
| `security.log` | `npm run test:security` | 110 of 110 pass (11 new inventory API tests; Stage 08 public-read tests now count stock first) |
| `e2e-pages.log` | `npm run test:e2e` | 19 of 19 pass (1 new inventory pages test) |
| `parity/`, `parity-diff.log` | Stage 05 to 07 suites recorded and compared with Stage 08 | 268 of 270 identical; the 2 differences are intended (`/admin/me` lists `inventory.approve`; an audit entry differs by a random ID) |
| `worker-run.log` | Worker process against a throwaway database | All 5 jobs ran; `/health` and `/ready` answer |
| `lint-typecheck.log`, `build.log`, `images.log`, `secret-scan.log` | Lint, typecheck, `npm run build`, both images, secret scan | Clean, compiled, built, no secrets |

## Browser check (16 October 2026)

API and `next dev` on a throwaway database; signed in as a test owner created for the check (deleted afterwards). A live product with three sizes and approved photos:

- `stock-uncounted.jpg`: all three SKUs "Not counted yet"; the product was not in the public API.
- Counted by hand (S 5, M 2, L 0) and finished counting. `stocktake-awaiting-approval.jpg`: the report with two differences and Accept boxes; approval stays disabled until each is accepted, the statement confirmed and a name typed.
- Approved and signed: `stocktake-signed.jpg` shows the signed report. The public API then listed the product: S and M for sale, L not.
- `sku-received.jpg`: received 4 units of L; numbers, status ("For sale") and history updated.
- Phone width 375 px: no sideways scroll on the stock list, SKU page or stocktake.
- Found and fixed during the check: "Finish counting" saved the counts but sent the submit with the old version, and the page refresh hid the 412. Submit now uses the version the save returned, and errors stay visible; the stock actions panel likewise keeps its messages.

## Not verified

- No real catalogue, stock count, Shopify export or signed report exists yet.
- Reservations have no HTTP caller until checkout (Stage 11); the late-capture path awaits payments (Stage 14).
- The reconciliation job compares the ledger with balances created inside the ledger; balances created with a starting quantity outside it (only the synthetic development seed does this) are reported as mismatches by design.

## Open items for the owner

1. Confirm decision 035: only the OWNER signs stocktakes; holds last 15 minutes plus 30 minutes for a payment in progress.
2. Provide the real product sheet (and, if wanted, the old Shopify products export) and do the first physical count; sign it in Admin, Inventory, Stocktakes.
3. Keep the signed reconciliation report with the shop's records.
4. Still open: decisions 033 and 034, photo storage provider, API and worker hosting, `BETTER_AUTH_SECRET` in `.env.local`, admin domain spelling, refund threshold, legal review, email provider.
5. Reviewer for Stage 09: unassigned.
