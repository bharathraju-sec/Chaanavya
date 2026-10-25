# Stage 11 maintenance: pre-Stage-12 fixes F01 to F04 (25 October 2026)

Source: the owner's pre-Stage-12 fix handover (baseline `4559c15`, branch `upgrade`). The branch head was confirmed at `4559c15` before editing; no fix was already present. Stage 12 was not started; checkout stays closed and the cart still reserves no stock.

| ID | Status | What changed |
|---|---|---|
| F01 | FIXED | `apps/api/src/cart/ownership.ts` `openCart` locks the owner's row (`user`, or `guest_session`) `FOR UPDATE` before looking for or creating a cart, and refuses an unverified or disabled customer. Concurrent first adds queue and share one cart. Lock order everywhere: owner, guest session (merge), carts. Expired carts stay as history (purge job later); no time-based unique index. |
| F02 | FIXED | `apps/api/src/cart/cart.ts`: `parseLineToAdd` (shape only), `findAddReplay` (same current cart and key: same body returns the current bag without writing or re-checking stock and publication; different body `409`), `checkAddable` (on-sale and stock check for a new key only), and `addLine` now checks on-sale status inside its locked transaction too. `apps/api/src/modules/cart.controller.ts` runs the replay lookup first and again after a refusal (for a parallel retry that landed). Idempotency is scoped to the current cart. |
| F03 | FIXED | `apps/api/src/cart/merge-apply.ts`: in the merge transaction the account bag's own code wins (`account_kept`); otherwise the guest bag's code moves over (`carried`), bumping the account revision; a code alone moves only into an existing account bag; the guest bag's code is cleared. Nothing is checked or counted at merge time; every read checks the code as the customer (account usage). The `cart.merged` audit adds `promotion`. |
| F04 | FIXED | `apps/api/src/auth/guest.ts`: the guest cookie is checked as sent (no percent-decoding), so malformed values are not a token and never reach the database; `hasGuestCookie` lets `apps/api/src/modules/cart.controller.ts` and the sign-in hook in `apps/api/src/auth/server.ts` clear any unusable guest cookie. |

**Policy recorded (the handover's proposed defaults):** unverified email shops as a guest; 10 per variant, 30 lines; 30-day idle expiry; abandoned after 24 hours, reporting only; merge keeps the larger quantity capped at 10, stock checked at quote time; promotion precedence: the account's code wins, otherwise the guest's code is carried and always revalidated. These match the existing behaviour except the new promotion precedence (F03).

**Migration:** none. **Schema:** unchanged.

**Tests:** `tests/security/cart/maintenance.test.mjs` (new, 15 tests: CHV-S11-F01-A, F01-B, F02-A, F02-B, F02-C, F03-A, F03-B, F03-C, F04-A, F04-B and supporting cases; log `maintenance-f01-f04.log`). `tests/security/cart/merge-at-sign-in.test.mjs`: the audit `after` now includes `promotion: "none"`.

**Mutation checks** (each fix undone in turn, then restored): no owner lock fails 3 (F01); no replay lookup before or after the checks fails 2 (F02-A, F02-B); code not carried fails 5 (F03); percent-decoding again fails 1 (F04-A).

**Combined maintenance gate** (run once after all four fixes; the first run found the new test file passing fixture objects where variant ids belong, a test mistake, fixed; then the complete gate was run again):

| Check | Result |
|---|---|
| `npm run db:up`, `npm run build:api` | ok |
| `npm run test:db` | 61 of 61 |
| `npm run test:security` | 286 of 286 |
| `npm test` | 95 of 95 |
| `npm run build` | passes |
| `npm run test:e2e` | 58 of 58 (includes the Stage 11 gate: no stock reserved, no checkout or payment route, no identifier leaks) |
| `npm run lint` | 0 errors, 2 existing warnings (unused names in `tests/e2e/catalogue-gate.test.mjs` and `tests/security/catalogue/refresh.test.mjs`) |
| `npm run typecheck` | clean |

**Residual risks:** the one-cart guarantee relies on every cart creator going through `openCart` inside a transaction (all do today; a new writer must too). A lost response on a guest's very first add still cannot be replayed into the same bag (the cookie never arrived). Deferred items from the handover are unchanged: purge job, promotion admin screen, real catalogue and stocktake, hosting and providers, dependency advisories and the development MFA waiver, README wording.

**Rollback:** revert the maintenance commit; no data or schema change to undo.
