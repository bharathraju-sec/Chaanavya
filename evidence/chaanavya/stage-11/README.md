# Stage 11 evidence: cart, guest sessions and promotions

## 11.01 Define cart ownership and expiry: PASS (23 October 2026)

Start: the owner asked to implement 11.01 on 23 October 2026, which is taken as acceptance of the Stage 10 gate.

**Changed**

- `apps/api/src/cart/ownership.ts` (new): `cartOwnerOf`, `ownedBy`, `findOwnedCart`, `findCurrentCart`, `openCart`, `renewCart`, `cartExpiry`, `cartState`, `CART_LIFETIME`.
- `tests/security/cart/ownership.test.mjs` (new).
- `docs/architecture/cart-ownership.md` (new, local docs).
- No schema change: the existing `cart`, `cart_line` and `guest_session` tables and the `cart_single_owner` CHECK are reused.

**Rules defined**

- **Owner:** a customer (user id) or a live guest session. A signed-in shopper is always the customer.
- **Access:** a cart is found by its id and its owner together. Every refusal returns no cart (not_found).
- **Expiry:** 30 days after the last change, renewed on change. A guest cart is capped at its guest session's expiry. An expired cart reads as missing.
- **Abandoned:** a live cart with lines and no change for 24 hours. Reporting only; nothing is sent.
- **Concurrent changes:** compare-and-set on the revision, so one writer wins and a replay is refused.
- **Stock:** nothing reserved.

**Commands and results**

- `npm run db:up`, `npm run build:api`.
- `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/support/register.mjs --test tests/security/cart/ownership.test.mjs`: 16 of 16 pass (CHV-S11-M01). Log: `11.01-cart-ownership.log`.
- `npm run test:security`: 172 of 172 pass.
- `npm run --workspace @chaanavya/api typecheck`: clean.
- `npx eslint` on the two new files: clean.
- **Mutation check:** with the owner filter removed from `findOwnedCart`, 5 of 16 tests fail (another guest, customer and guest, revoked session, expired session, racing guests). The file was restored and the API rebuilt.

**Open**

- No cart route uses these rules yet; the storefront bag is still the browser-only demo cart.
- Guest-to-customer merge and the cart API come in later 11.x steps.
- No worker job deletes expired carts yet.
- The 30-day and 24-hour values are defaults, not owner-approved terms.

## 11.02 Implement guest cart persistence: PASS (25 October 2026)

**Changed**

- `apps/api/src/cart/cart.ts` (new): `readCart`, `lineToAdd`, `addLine`, `setLineQuantity`, `CART_LIMITS` (10 per line, 30 lines). Each change locks the cart row, applies the change and bumps the revision with the 11.01 compare-and-set.
- `apps/api/src/modules/cart.controller.ts` (new): `GET /api/v1/cart`, `POST /api/v1/cart/lines`, `PATCH /api/v1/cart/lines/:lineId`; registered in `apps/api/src/app.module.ts`.
- `apps/api/src/catalogue/public.ts`: `PUBLIC_PRODUCT` exported (unchanged filter). `apps/api/src/cart/ownership.ts`: `openCart` accepts a transaction.
- `components/cart/cart-provider.tsx`: the bag reads and changes `/api/cart` instead of localStorage, and clears the old demo copy. `components/cart/cart-sheet.tsx`: the plus button stops at 10.
- `packages/contracts/openapi/api.json` and `packages/contracts/src/api/schema.ts`: regenerated (`npm run api:openapi`).
- `tests/security/cart/guest-cart.test.mjs` (new). `tests/e2e/catalogue-gate.test.mjs`: CHV-S10-M11 now allows cart paths; checkout, payment, webhook and quote paths stay forbidden.
- No schema change.

**Session reference**

- A guest session starts only on the first accepted add; reads and refused adds create none.
- Cookie `chaanavya_guest`: 32 random bytes, only the SHA-256 hash stored, HttpOnly, SameSite=Lax, Path=/, host-only, Secure in production and over https. A cookie the shop no longer honours is cleared on read.
- Responses carry no user, guest session, token or email. This narrows `CartV1.owner` in the contracts, which the route does not return.

**Commands and results**

- `npm run build:api`, then `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/support/register.mjs --test tests/security/cart/guest-cart.test.mjs`: 14 of 14 pass (CHV-S11-M02). Log: `11.02-guest-cart.log`.
- `npm run test:security`: 186 of 186 pass (172 before plus 14).
- `npm test`: 95 of 95. `npm run test:e2e`: 47 of 47.
- `npm run --workspace @chaanavya/api typecheck` and `npx tsc --noEmit`: clean. `npx eslint` on the changed files: clean apart from an existing unused-variable warning in `tests/e2e/catalogue-gate.test.mjs`.
- **Mutation checks:** without the row lock, the concurrent-add test fails (1 of 14); without the owner and cart filter on line changes, the other-guest test fails (1 of 14). Both restored and the API rebuilt.
- **Browser (local dev, port 5601, pane hidden so checked by script and page text):** added Sovereign Trench Coat size M, the bag showed 1 item, the guest cookie was not readable by page scripts, the bag was still there after a reload (M, Rs 4,999), plus raised it to 2 (Rs 9,998) and Remove emptied it.

**Open**

- Scope overlap: a basic add and quantity change (0 removes) were needed to show a guest bag surviving a reload; they overlap 11.04 and 11.05, and signed-in customers already get their own bag (11.03). Those steps should verify and extend these routes.
- Guest-to-customer merge at sign-in, quotes bound to a revision, and the purge of expired carts and guest sessions are later 11.x steps.
- New guest sessions are limited only by the API-wide 600 requests a minute per IP.
- The 10-per-line and 30-line limits are defaults, not owner-approved terms.
- The catalogue in the local database is still placeholder data, not confirmed merchandise.

## 11.03 Implement authenticated cart persistence: PASS (25 October 2026)

**Changed**

- `apps/api/src/cart/ownership.ts`: a cart is owned only by a verified, enabled account. `cartOwnerOf` takes `emailVerified` (an unverified signed-in user shops as a guest), and `ownedBy` adds `user.emailVerified = true` and `disabledAt = null` to every customer cart query.
- `apps/api/src/auth/session.ts`: `resolveShopper` also returns the signed-in user's `emailVerified` (order ownership unchanged).
- `apps/api/src/cart/cart.ts`: `readOwnedCart` (one cart by id and owner). `apps/api/src/modules/cart.controller.ts`: `GET /api/v1/cart/:cartId`, the same 404 for every id that is not the caller's.
- `packages/contracts/openapi/api.json`, `packages/contracts/src/api/schema.ts`: regenerated.
- `tests/security/cart/customer-cart.test.mjs` (new). `tests/security/cart/ownership.test.mjs`: the `cartOwnerOf` calls pass `emailVerified` (same assertions).
- No schema change, no storefront change.

**Commands and results**

- `npm run build:api`, then `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/support/register.mjs --test tests/security/cart/customer-cart.test.mjs`: 9 of 9 pass (CHV-S11-M03). Log: `11.03-customer-cart.log`. Same command for `guest-cart` 14 of 14 and `ownership` 16 of 16.
- `npm run test:security`: 195 of 195. `npm test`: 95 of 95. `npm run test:e2e`: 47 of 47.
- `npx eslint` on the changed files and `npx tsc --noEmit`: clean. API typecheck clean.
- **Mutation checks:** without the verified and enabled filter in `ownedBy`, the unverified/disabled test fails (1 of 9); reading a cart by id without the owner fails 3 of 9 (another account, guest holding the id, guest bag before sign-in). Both restored and the API rebuilt.
- Not checked in the browser: there is no storefront change, and signing in needs an emailed code.

**Open**

- A guest bag from before sign-in is not merged into the customer's (11.07 and 11.08).
- Policy for the owner to confirm: an account whose email is not verified gets no customer bag and shops on a guest cookie instead.

## 11.04 Add cart item endpoint: PASS (25 October 2026)

**Changed**

- `apps/api/src/cart/cart.ts`: `addKeyOf` (required `Idempotency-Key`), `addLine` records the key with a request hash and returns the bag unchanged on a replay (revision unchanged), refuses the same key for a different add, and checks the new line total against the stock free now (on hand minus held minus allocated) inside the locked change. A `null` quantity is now refused (only a missing quantity defaults to 1).
- `apps/api/src/modules/cart.controller.ts`: the add reads the key before the body and before any guest session starts; OpenAPI documents the header.
- `apps/api/prisma/schema.prisma`, migration `20261025000000_cart_requests` and rollback `apps/api/prisma/rollback/20261025000000_cart_requests.down.sql`: new `cart_request` table (cart id + key, request hash), deleted with its cart. Additive. Applied to the local `chaanavya_dev` database.
- `components/cart/cart-provider.tsx`: sends a new key per press.
- `packages/contracts/openapi/api.json`, `packages/contracts/src/api/schema.ts`: regenerated.
- Tests: `tests/security/cart/add-item.test.mjs` (new); `guest-cart` and `customer-cart` helpers send a key, and the kurta fixture holds 50 so the existing quantity tests fit the new stock check; `tests/integration/database/schema.test.mjs` expects 37 tables including `cart_request`.

**Commands and results**

- `npm run build:api`, then `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/support/register.mjs --test tests/security/cart/add-item.test.mjs`: 10 of 10 pass (CHV-S11-M04). Log: `11.04-add-item.log`. The first run found that `"quantity": null` was treated as 1; fixed.
- `npm run test:security`: 205 of 205. `npm run test:db`: 61 of 61 (includes migration drift and rollback rehearsal, after adding the rollback script and the table to the list). `npm test`: 95 of 95. `npm run test:e2e`: 47 of 47.
- `npx eslint` on the changed files, `npx tsc --noEmit` and the API typecheck: clean.
- **Mutation checks:** without the key lookup, 2 of 10 fail (retried add, concurrent same key); without the stock check in the change, 2 of 10 fail (availability, racing adds). Restored and rebuilt.
- **Browser (local dev):** an add without a key answers 428; the storefront's add sends a key, answers 200 and the bag shows the item.

**Open**

- Stock is checked at add time only; a bag is not re-checked against stock on read (quote time, later).
- A lost response on a guest's very first add cannot be replayed into the same bag (the cookie never arrived).
- Old `cart_request` rows live as long as their cart; the purge job is not built.

## 11.05 Update quantity endpoint: PASS (25 October 2026)

**Changed**

- `apps/api/src/cart/cart.ts`: `setLineQuantity` raises only when the item is on sale now and the new quantity fits the free stock (read inside the locked change); lowering and removing are always allowed; the same quantity again is a no-op that keeps the revision.
- `apps/api/src/modules/cart.controller.ts`: route description. `packages/contracts/openapi/api.json`, `packages/contracts/src/api/schema.ts`: regenerated.
- `tests/security/cart/update-quantity.test.mjs` (new).
- No schema or storefront change (the bag's plus button already stops at 10).

**Commands and results**

- `npm run build:api`, then `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/support/register.mjs --test tests/security/cart/update-quantity.test.mjs`: 9 of 9 pass (CHV-S11-M05). Log: `11.05-update-quantity.log`. The other cart files with the same command: `add-item` 10/10, `guest-cart` 14/14, `customer-cart` 9/9, `ownership` 16/16.
- `npm run test:security`: 214 of 214. `npm test`: 95 of 95. `npm run test:e2e`: 47 of 47.
- `npx eslint` on the changed files, `npx tsc --noEmit` and the API typecheck: clean.
- **Mutation checks:** without the stock and on-sale check on a raise, 2 of 9 fail; with the limit loosened to 99, the invalid-quantity test fails (1 of 9). Restored and rebuilt.
- **Browser (local dev):** in the bag, plus took the coat from 1 to 2 (Rs 4,999 to Rs 9,998) and minus back to 1, totals from the server.

**Open**

- `CartService.updateLine` in the contracts takes an `IdempotencyKey`; the route does not need one because the quantity is absolute (a replay is harmless). The interface is not implemented by any class, so nothing breaks.
- The bag is not re-checked against stock on read; a line above the free stock is only stopped from growing.

## 11.06 Remove and clear cart endpoints: PASS (25 October 2026)

**Changed**

- `apps/api/src/cart/cart.ts`: `removeLine` and `clearCart`, both scoped to the owner's live cart inside the locked change and idempotent (nothing to remove returns the bag unchanged, same revision). Clear keeps the cart row, revision and add keys.
- `apps/api/src/modules/cart.controller.ts`: `DELETE /api/v1/cart/lines/:lineId` and `DELETE /api/v1/cart`; no session or no bag returns `{ data: null }` and starts no guest session.
- `components/cart/cart-provider.tsx`: the bag's Remove uses the remove route; requests without a body send no content type.
- `packages/contracts/openapi/api.json`, `packages/contracts/src/api/schema.ts`: regenerated.
- `tests/security/cart/remove-clear.test.mjs` (new).
- No schema change. No "clear bag" button in the shop.

**Commands and results**

- `npm run build:api`, then `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/support/register.mjs --test tests/security/cart/remove-clear.test.mjs`: 11 of 11 pass (CHV-S11-M06). Log: `11.06-remove-clear.log`. Other cart files with the same command: `update-quantity` 9/9, `add-item` 10/10, `guest-cart` 14/14, `customer-cart` 9/9, `ownership` 16/16.
- `npm run test:security`: 225 of 225. `npm test`: 95 of 95. `npm run test:e2e`: 47 of 47.
- `npx eslint` on the changed files, `npx tsc --noEmit` and the API typecheck: clean.
- **Mutation checks:** removing by line id without the cart and owner filter fails 6 of 11 (including the other-shopper test); a clear that always counts as a change fails the repeated-clear test (1 of 11). Restored and rebuilt.
- **Browser (local dev):** Remove in the bag sends `DELETE /api/cart/lines/:id` (200) and the bag shows 0 items.

**Open**

- `CartService.removeLines` in the contracts takes several line ids and a key; the route removes one line and needs no key (removal is idempotent). No class implements the interface.
- The clear route has no caller in the shop yet.

## 11.07 Define guest-to-customer merge policy: PASS (25 October 2026)

**Owner decisions (25 October 2026, asked in this session):** same item keeps the larger quantity; unavailable guest items are brought over flagged; over 30 lines, account items first; afterwards the guest bag is emptied and its guest session ended.

**Changed**

- `apps/api/src/cart/merge.ts` (new): `planMerge(account, guest, limits)`, a pure, deterministic function returning the merged lines (variant, quantity, source), the guest items left behind and whether the account bag changes. Header comment states each rule.
- `tests/security/cart/merge-policy.test.mjs` (new). Local `docs/architecture/cart-ownership.md`: policy table.
- No route, schema or storefront change. Nothing calls `planMerge` yet (11.08 applies it).

**Commands and results**

- `npm run build:api`, then `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/support/register.mjs --test tests/security/cart/merge-policy.test.mjs`: 11 of 11 pass (CHV-S11-M07), including 50 shuffled orderings and 300 seeded random bag pairs. Log: `11.07-merge-policy.log`.
- `npm run test:security`: 236 of 236. `npm test`: 95 of 95. `npx eslint` and `npx tsc --noEmit`: clean. (No route or page change, so end-to-end and browser checks were not rerun.)
- **Mutation checks:** adding quantities up instead of the larger fails 5 of 11; keeping guest input order instead of newest first fails 5 of 11. Restored and rebuilt.

**Open**

- Ending the guest session also ends that browser's cookie access to guest orders. They stay reachable through the Stage 05 claim (`POST /api/account/claim-order`: order number and matching verified email). None exist yet (checkout closed).
- "Larger quantity" is not capped at current stock at merge time; quote time checks stock.

## 11.08 Implement transactional cart merge: PASS (25 October 2026)

**Changed**

- `apps/api/src/cart/merge-apply.ts` (new): `mergeGuestCart` applies the 11.07 policy in one transaction with a fixed lock order (user row, guest session, guest cart, account cart), bumps the account revision with the compare-and-set, empties the guest bag, revokes the guest session and records `cart.merged` (added, raised, left behind; no token or guest session id). Unverified or disabled accounts are skipped.
- `apps/api/src/auth/server.ts`: the Better Auth after-hook runs the merge whenever a session is created and a guest cookie is present, then clears `chaanavya_guest` (kept only when skipped). A failed merge is logged and never blocks sign-in. `apps/api/src/auth/audit.ts`: `cart.merged` action.
- `components/cart/cart-provider.tsx`: `refresh()` on the bag context (here and other tabs). `components/account/sign-in-form.tsx`: refreshes the bag after sign-in and sign-out (the pages navigate client-side, so the bag would otherwise show the old owner's lines).
- Tests: `tests/security/cart/merge-at-sign-in.test.mjs` (new); `tests/security/cart/customer-cart.test.mjs`: the "no merge yet" test now expects the merge (cookie retired, items copied, guest cart keeps its guest owner).
- No schema change.

**Commands and results**

- `npm run build:api`, then `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/support/register.mjs --test tests/security/cart/merge-at-sign-in.test.mjs`: 11 of 11 pass (CHV-S11-M08). Log: `11.08-merge-at-sign-in.log`.
- `npm run test:security`: 247 of 247. `npm test`: 95 of 95. `npm run test:e2e`: 47 of 47. `npx eslint` and `npx tsc --noEmit`: clean.
- **Mutation checks:** not ending the guest session fails 3 of 11; not clearing the cookie fails 4 of 11; no user-row lock fails the two-guests-at-once test (one cart per account). Restored and rebuilt.
- **Browser (local dev):** a guest bag of 3 items, then a real email-code sign-in (test address `merge.browser@example.com`, code read from the local API's development log): the page went to `/account` with the bag showing 3 items; the database shows the account bag with 3 units and one `cart.merged` event. Signing out showed 0 items straight away. The local start script needed `BETTER_AUTH_URL=http://localhost:5601` (scratchpad only, not a project file) because sign-in from port 5601 was refused as an untrusted origin.

**Open**

- Merges run in the sign-in request; a very large guest bag (30 lines) adds a few queries to sign-in.
- The local default `BETTER_AUTH_URL` is `http://localhost:3000`; running the shop on another port needs it set.

## 11.09 Define promotion validity engine: PASS (25 October 2026)

**Changed**

- `apps/api/src/promotions/validity.ts` (new): `normaliseCode` and `evaluatePromotion`, pure: active window (start inclusive, end exclusive), minimum subtotal, total usage limit, per-customer limit (by account, or by guest session for guests), discount in whole paise never above the subtotal, INR only. Unknown, malformed and switched-off codes are all `not_found`.
- `apps/api/src/promotions/check.ts` (new): `checkPromotion` loads the code and, for a per-customer limit, counts the shopper's non-cancelled orders with it (by user id, or by guest session id), then asks the engine. Reads only.
- `tests/security/promotions/validity.test.mjs` (new).
- No route, schema or storefront change; the `promotion` table and its CHECK constraints are from Stage 04. Nothing applies a code to a bag yet (11.10).

**Commands and results**

- `npm run build:api`, then `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/support/register.mjs --test tests/security/promotions/validity.test.mjs`: 9 of 9 pass (CHV-S11-M09). Log: `11.09-promotion-validity.log`.
- `npm run test:security`: 256 of 256. `npm test`: 95 of 95. `npx eslint`, `npx tsc --noEmit` and the API typecheck: clean.
- **Mutation checks:** making the end time inclusive fails the expiry boundary test (1 of 9); not counting a guest session's orders fails the per-customer test (1 of 9). Restored and rebuilt. (An earlier check, from before the owner allowed guests, showed letting guests past the limit failed 2 of 9.)

**Owner decisions (25 October 2026, asked after the first version)**

- Changed: guests may use codes with a per-customer limit; their use is counted per guest session (a shopper can get round it by starting a new guest session). The first version required sign-in (`sign_in_required`), which is removed.
- Kept: orders awaiting payment count as a use, cancelled orders do not; percentages round down to the paisa; an expired or not-yet-started code says so, a switched-off code looks unknown.

**Open**

- `usage_count` is not raised anywhere yet; that belongs where an order takes the code (checkout, Stage 12+), in the same transaction.
- No admin screen to create promotions; codes exist only if inserted directly.

## 11.10 Implement basic coupon application: PASS (25 October 2026)

**Owner decisions (25 October 2026, asked in this session):** a code applies to every item, reduced ones included; one code per bag, and a valid new code replaces the old one (an invalid new code leaves the old one).

**Changed**

- `apps/api/prisma/schema.prisma`, migration `20261025010000_cart_promotion` and rollback `apps/api/prisma/rollback/20261025010000_cart_promotion.down.sql`: `cart.promotion_id` (nullable, set null if the promotion is deleted). Additive. Applied to local `chaanavya_dev`.
- `apps/api/src/cart/cart.ts`: the bag view adds `promotion` (code, applied or not and why), `discount` and `total`, checking the applied code again on every read; `applyPromotion` (replace, refuse with the reason, same code is a no-op) and `removePromotion` (idempotent). `apps/api/src/cart/ownership.ts`: cart fields include `promotionId`.
- `apps/api/src/promotions/check.ts`: shared `decide`, plus `checkAppliedPromotion` (by id).
- `apps/api/src/modules/cart.controller.ts`: `POST /api/v1/cart/promotion` (10 tries a minute per IP) and `DELETE /api/v1/cart/promotion`; response schema adds `promotion`, `discount`, `total`.
- `components/cart/cart-provider.tsx`: `promotion`, `discount`, `total`, `applyCode`, `removeCode` and shopper-facing reasons. `components/cart/cart-sheet.tsx`: promo code field, applied code with Remove, Discount and Total rows.
- `packages/contracts/openapi/api.json`, `packages/contracts/src/api/schema.ts`: regenerated (52 paths).
- Tests: `tests/security/cart/promotion-apply.test.mjs` (new); `tests/security/cart/guest-cart.test.mjs`: the response-fields check includes `promotion`, `discount`, `total`.

**Commands and results**

- `npm run build:api`, then `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/support/register.mjs --test tests/security/cart/promotion-apply.test.mjs`: 15 of 15 pass (CHV-S11-M10). Log: `11.10-coupon-application.log`.
- `npm run test:db`: 61 of 61 (drift and rollback rehearsal include the new column). `npm run test:security`: 271 of 271. `npm test`: 95 of 95. `npm run test:e2e`: 47 of 47.
- `npx eslint apps/api/src components/cart tests/security` (one existing warning in `tests/security/catalogue/refresh.test.mjs`), `npx tsc --noEmit` and the API typecheck: clean.
- **Mutation checks:** applying codes without the validity check fails 4 of 15 (expired and others refused, no stacking, minimum, per-customer); removing the rate limit fails the guessing test (1 of 15). Restored and rebuilt.
- **Browser (local dev):** a temporary local code `DEVTEST10` (10 percent) was added to `chaanavya_dev`, then deleted. In the bag, `nope` showed "This code is not valid."; `devtest10` showed the code applied, Subtotal Rs 4,999, Discount Rs 499.90, Total Rs 4,499.10; Remove returned the field and dropped the discount rows.

**Open**

- The guest bag's code is not carried into the account bag at sign-in (lines only).
- `usage_count` is still not raised anywhere (checkout).
- The bag total is display only; the quote (Stage 12) prices the bag again with shipping and tax.

## 11.11 Connect existing cart drawer: PASS (25 October 2026)

**Finding:** the bag drawer was already moved onto the shop's own cart API in 11.02 (`components/cart/cart-provider.tsx` makes one `fetch`, to `/api/cart`). A search of `app`, `components`, `lib` and the site config found no Shopify cart or checkout code left; the remaining Shopify mentions are the admin's stocktake import of old Shopify exports and the legacy Shopify id fields kept for catalogue migration, both intended. The only reference to the old browser-only bag is the line that deletes its leftover `localStorage` copy.

**Changed**

- `tests/e2e/cart-drawer.test.mjs` (new): runs `next start` on the production build against the in-process API and sends exactly the drawer's requests through the web host.
- No application code change.

**Commands and results**

- `npm run build` (production build, retried past the Next.js security notice as before), then `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/support/register.mjs --test tests/e2e/cart-drawer.test.mjs`: 5 of 5 pass (CHV-S11-M11). Log: `11.11-cart-drawer.log`.
- `npm run test:e2e`: 52 of 52 (47 before plus 5). `npm run test:security`: 271 of 271. `npm test`: 95 of 95. `npx eslint` on the new test: clean.
- **Mutation check:** writing the bag to `localStorage` again in the provider fails the no-browser-bag test (1 of 5). Restored.
- **Browser (local dev):** adding from a product card on `/new-arrivals` (size dialog, Add to bag) took the bag from 1 to 2 items with the "added to bag" message; adding, changing, removing and promo codes on the product page and in the drawer were checked in 11.02 to 11.10.

**Checked**

- Through the web host: an empty bag reads null; add sets the guest cookie; the second add, quantity change, code apply and remove, line remove (twice) and clear all return the bag with totals from the API; the bag survives a reload and is never cached; API errors (400, 428, 403 cross-site) reach the drawer unchanged.
- The provider makes one request, to `/api/cart`, sends a key with adds and keeps nothing in browser storage; no storefront source and no built browser chunk contains a Shopify endpoint.
- Adding to the bag changes no stock balance and creates no reservation.

## 11.12 Cart integration and leakage gate: PASS (25 October 2026)

**Changed**

- `tests/e2e/cart-gate.test.mjs` (new): the Stage 11 gate, real HTTP against `next start` on the production build with the API in-process on a throwaway database. Each test browser sends its own `x-forwarded-for`, as separate visitors do (sign-in codes are limited to 3 a minute per address, which the first run hit).
- No application code change.

**Checked**

- **Journey:** a guest adds two items and reloads (bag kept); the same person already has an account bag on another device; signing in merges (larger quantity kept, nothing doubled) and retires the guest cookie; the other device sees the same bag; signing in again with the dead guest cookie merges nothing; a valid quantity change works and an invalid one is refused; after sign-out the browser has no bag and the next add starts a new guest bag.
- **Current prices and availability:** a price change shows at once in the line and subtotal; when other orders take the stock the line can be lowered, not raised; a product taken off sale is flagged, left out of the subtotal, cannot be added again, and can still be removed.
- **API unreachable:** the web host answers `502 { error: "api_unavailable" }` with `no-store` for every cart route; the drawer shows a message and keeps what it had.
- **No leakage:** across the bag, by-id, line change, line remove and code routes, no response from any shopper contains another's user id, email, guest token or guest session id; another account's cart and lines are 404; every cart response is `no-store`; the merge audit holds no guest token.
- **Checkout closed:** `/checkout`, `/payment`, `/api/checkout`, `/api/payments`, `/api/quotes`, `/api/cart/checkout` and the Razorpay webhook path do not exist; the API has no checkout, payment, quote or webhook path; the bag's checkout button is the disabled "Checkout opens soon".
- **No stock reserved:** after every cart action in the journey and a run of adds, changes, removals and a clear, every stock balance (on hand, reserved, allocated, version) is unchanged and no reservation, stock movement or order exists.

**Commands and results (Stage 11 gate run)**

- `npm run build:api`, then `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/support/register.mjs --test tests/e2e/cart-gate.test.mjs`: 6 of 6 pass (CHV-S11-M12). Log: `11.12-cart-gate.log`.
- `npm run lint`: 0 errors, 2 existing warnings (unused names in `tests/e2e/catalogue-gate.test.mjs` and `tests/security/catalogue/refresh.test.mjs`, from Stage 10). `npm run typecheck` (web, API, worker): clean.
- `npm run test:db`: 61 of 61. `npm run test:security`: 271 of 271. `npm test`: 95 of 95. `npm run test:e2e`: 58 of 58. Production build `npm run build`: passes (from 11.11; no web code changed since).
- **Mutation check:** making an add reserve stock fails 3 of 6 gate tests (journey, prices, never reserves). Restored and rebuilt.

## Stage 11 gate summary

All twelve micro-stages pass (CHV-S11-M01 to M12). The bag is kept by the NestJS API for guests and verified customers, merges at sign-in, takes one promo code, never trusts browser prices, never reserves stock, and checkout stays closed. Awaiting the owner's acceptance of the Stage 11 gate.

Owner decisions recorded during Stage 11 (25 October 2026): merge keeps the larger quantity, brings unavailable items over flagged, keeps account items first under the line limit, and ends the guest session; guests may use per-customer promo codes (counted per guest session); awaiting-payment orders count as a use; percentages round down; expired and not-started codes say so; a code applies to every item including reduced ones; one code per bag, a valid new code replaces the old one.

Still for the owner to confirm: unverified-email accounts shop as guests; line limits (10 per item, 30 lines); cart lifetimes (30 days, abandoned after 24 hours).
