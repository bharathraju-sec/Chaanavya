# Stage 12 evidence: Indian checkout, tax and shipping quotes

Workspace `backup/upgrade`, branch `upgrade`, on top of `52c8f5c` (Stage 11 with the pre-Stage-12 fixes). Checkout stays closed; nothing here reserves stock, takes payment or calls a courier.

## 12.01 Model Indian shipping addresses (CHV-S12-M01), 26 October 2026

**Status:** PASS. Started on the owner sending the Stage 12.01 file, taken as acceptance of the Stage 11 gate.

**What changed**

- `apps/api/src/checkout/address.ts` (new): `parseIndianAddress` checks an address on the server and returns it cleaned; every problem is named at once in `fields` (`required`, `invalid`, `too_long`) with a 400 `invalid_request`.
  - Mandatory: recipient name, phone, line 1, city, district, state code, PIN code. Optional: line 2, landmark. Country India only (omitted means India).
  - Text is trimmed with inner spaces collapsed; control characters and non-string values are refused; name, city and district up to 100 characters, address lines up to 200.
  - Phone: an Indian mobile (10 digits starting 6 to 9); spaces, hyphens, brackets and a `+91`, `91` or `0` prefix are accepted and stored as E.164 `+91XXXXXXXXXX`.
  - PIN: six digits, first digit 1 to 9. State: shape `IN-XX`, upper-cased. Whether the state code is real and the PIN belongs to it is Stage 12.02.
- Saved address and guest snapshot kept apart:
  - `saveAddress(db, customerId, body)` writes a checked address to a customer's address book (`address`, `user_id` NOT NULL, no guest column). No route yet (Stage 12.03).
  - `guestAddressSnapshot(body)` checks a guest's address and returns the snapshot only; guests never get an address book row.
  - `addressSnapshot(saved)` copies a saved address into the frozen shape an order keeps (`order.shipping_address`): address fields only, no id, owner, default flag or dates, so later edits never reach the order.
- Contracts (`packages/contracts/src/modules/checkout.ts`, `common.ts`): `IndianAddressV1` gains `district`; new `SavedAddressV1` (id, address, isDefault, updatedAt) and `AddressId`. `IndianAddressV1` stays the snapshot and quote shape. Nothing produced `IndianAddressV1` before this, so the new required field breaks no caller.
- Migration `20261026000000_address_fields` (rollback `apps/api/prisma/rollback/20261026000000_address_fields.down.sql`): adds `address.district` NOT NULL and CHECK constraints (name, line 1, city, district not blank and within length; line 2 and landmark within length; phone `^\+91[6-9][0-9]{9}$`; state code `^IN-[A-Z]{2}$`). The PIN and country checks were already there. The local `address` table was empty when applied. Applied to local `chaanavya_dev`.
- Fixtures: `tests/integration/database/helpers.mjs` and `snapshot.test.mjs` use a district and a mobile-shaped synthetic phone.

**Test:** `tests/security/checkout/address.test.mjs`, 12 tests (log `stage-12-01-address.log`):

- each mandatory field missing, null, empty or blank is `required`
- malformed PIN codes, non-mobile phones, badly shaped state codes, another country, wrong types, control characters and over-long text are refused, every problem reported at once
- an invalid address saves nothing
- the database itself refuses 13 kinds of invalid row written directly
- a guest snapshot leaves the address book untouched
- a snapshot from a saved address has no id or owner and ignores later edits

Command: `npm run build:api` then `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/support/register.mjs --test tests/security/checkout/address.test.mjs`. Result: 12 of 12 pass.

**Mutation checks** (each undone afterwards; the restored run passes 12 of 12):

- district not required in the server check: 3 tests fail
- database phone and district checks removed from the migration: 1 test fails ("blank district must be refused")

**Wider runs:**

| Check | Result |
|---|---|
| `npm run test:db` | 61 of 61 |
| `npm run test:security` | 298 of 298 |
| `npm test` | 95 of 95 |
| `npm run typecheck` | clean |
| `npm run lint` | 0 errors, the 2 existing warnings |

Not run for this micro-stage: `npm run build` and `npm run test:e2e`. The storefront is unchanged, so they belong to the Stage 12 gate. There is no browser check because there is no page or route yet.

**Owner decision (26 October 2026):** the defaults are kept: the delivery phone must be an Indian mobile (landlines refused), district is mandatory, name, city and district up to 100 characters and address lines up to 200.

## 12.02 Implement PIN and state validation (CHV-S12-M02), 26 October 2026

**Status:** PASS.

**What changed**

- `apps/api/src/checkout/region.ts` (new) keeps two questions apart:
  - Format: `isPinCode` checks six digits with the first 1 to 9. `INDIAN_STATES` lists the 36 ISO 3166-2:IN codes current since November 2023 (28 states, 8 union territories). `stateCodeOf` accepts a code in any case and stores codes replaced in 2023 (CT, OR, TS, UT) or merged in 2020 (DD, DN) as their current code; a name, a bare code without `IN-` or an unknown code is refused.
  - Delivery: `deliveryCheck(pin, courierAnswer)` returns `format`, `delivery` and `deliverable`. A well-formed PIN with no courier answer is `unknown` and not deliverable. Only a courier answer of serviceable (`ServiceabilityV1`, reason `ok`) makes it deliverable. An unavailable courier gives `unknown`; a refusal gives `not_serviceable`; a malformed PIN is never deliverable.
- `apps/api/src/checkout/address.ts`: the address check uses the region module, so the state must be a known code.
- Contract `packages/contracts/src/modules/checkout.ts`: new `DeliveryCheckV1`. Additive only.
- Migration `20261026010000_address_state_list` (rollback `apps/api/prisma/rollback/20261026010000_address_state_list.down.sql`): replaces the shape-only state check with a check against the 36 codes. Applied to local `chaanavya_dev`.
- Not checked: whether the PIN lies in the chosen state. India Post ranges cross state lines in places (Yanam, Puducherry, uses an Andhra Pradesh range), so a prefix table would refuse real addresses. The courier's answer (Stage 12.08) covers delivery.

**Test:** `tests/security/checkout/pin-state.test.mjs`, 8 tests:

- well-formed PINs (including 999999 and 123456) with no courier answer are `unknown` and not deliverable
- an address with such a PIN is still a valid address but not deliverable
- only a serviceable courier answer makes a PIN deliverable; a contradictory answer is not trusted
- malformed PINs are never deliverable, even with a courier yes
- the list has exactly 36 unique codes
- replaced codes are normalised
- unknown codes, names, bare codes and prototype-style keys are refused
- the database refuses unknown, replaced and lower-case codes, and stores all 36

Command: `npm run build:api` then `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/support/register.mjs --test tests/security/checkout/pin-state.test.mjs tests/security/checkout/address.test.mjs`. Result: 20 of 20 pass (log `stage-12-02-pin-state.log`).

**Mutation checks** (each undone afterwards; the restored run passes 8 of 8):

- a well-formed PIN treated as deliverable: 2 tests fail
- any `IN-XX` shape accepted as a state: 2 tests fail
- the database accepts any `IN-XX` shape: 1 test fails

**Wider runs:**

| Check | Result |
|---|---|
| `npm run test:db` | 61 of 61 |
| `npm run test:security` | 306 of 306 |
| `npm test` | 95 of 95 |
| `npm run typecheck` | clean |
| `npm run lint` | 0 errors, the 2 existing warnings |

Build and e2e are left for the Stage 12 gate (storefront unchanged).

## 12.03 Create saved-address APIs (CHV-S12-M03), 26 October 2026

**Status:** PASS.

**Routes:** in `apps/api/src/modules/address.controller.ts`, all `@Access.customer()` and `no-store`; the web host reaches them as `/api/account/addresses` through the existing forwarder.

| Route | Purpose |
|---|---|
| `GET /api/v1/account/addresses` | List, default first |
| `POST /api/v1/account/addresses` | Add, with body `{ address, isDefault? }`; answers 201 |
| `PATCH /api/v1/account/addresses/:addressId` | Edit, with body `{ address: {fields to change} }` |
| `POST /api/v1/account/addresses/:addressId/default` | Make the default |
| `DELETE /api/v1/account/addresses/:addressId` | Delete; answers 204 |

**Rules:** in `apps/api/src/checkout/address-book.ts`.

- **Ownership:** every lookup is by address id AND the customer's id. Another customer's address, a made-up or malformed id, and a deleted address all get the same 404 `not_found`, and nothing changes.
- **Verification:** a verified email is required (403 otherwise); signed out is 401; the existing same-origin check refuses other sites.
- **Checks:** every write goes through `parseIndianAddress` (12.01, 12.02). An edit is merged onto the stored address and checked as a whole, so a mandatory field cannot be cleared and a bad edit changes nothing.
- **Default:**
  - The first address becomes the default, and there is at most one default per customer.
  - Deleting the default makes the newest remaining address the default.
  - Writes lock the customer's row first (the same owner lock as the cart), so parallel requests queue.
- **Limit:** 20 addresses per customer (409 beyond that).
- **Privacy:** address text is not logged or audited. Orders keep their own copy (12.01), so edits and deletes never change an order.

**Migration:** `20261026020000_address_one_default` adds the partial unique index `address_one_default_per_user` (rollback `apps/api/prisma/rollback/20261026020000_address_one_default.down.sql`). Applied to local `chaanavya_dev`.

**OpenAPI:** `packages/contracts/openapi/api.json` and `packages/contracts/src/api/schema.ts` were regenerated with `npm run api:openapi`. Compared with the committed copy, the only change is the 3 address paths: nothing was removed or changed, and no checkout, payment or quote path was added.

**Test:** `tests/security/checkout/address-book.test.mjs`, 10 tests through the real routes with real OTP sign-ins (log `stage-12-03-address-book.log`):

- customer A cannot see, edit, make default or delete customer B's address; each answer is identical to a made-up id's, and B's row is unchanged byte for byte
- A's own edits never touch B's address
- signed out is 401, an unverified email is 403, another site is 403, and malformed ids are 404
- invalid adds name their fields and save nothing
- edits are checked as a whole
- the default rules hold, and the database refuses a second default
- the 20-address limit holds
- 6 parallel adds and 6 parallel default changes leave exactly one default
- B racing A's own edit on A's address gets 404 every time, and A's edit wins

Command: `npm run build:api` then `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/support/register.mjs --test tests/security/checkout/address-book.test.mjs`. Result: 10 of 10 pass.

**Mutation checks** (each undone afterwards; the restored run passes 10 of 10):

| Mutation | Result |
|---|---|
| Owner lookup ignores the customer | 2 tests fail |
| No owner lock | 1 test fails |
| Default index not unique | 1 test fails |
| Edit's write ignores the customer | No test fails |

The last mutation is unreachable through the routes: the owner lookup just before it already refuses another customer's id, so the write filter is a second safeguard.

**Wider runs:**

| Check | Result |
|---|---|
| `npm run test:db` | 61 of 61 |
| `npm run test:security` | 316 of 316, including the check that every route declares an access rule |
| `npm test` | 95 of 95 |
| `npm run typecheck` | clean |
| `npm run lint` | 0 errors, the 2 existing warnings |

Build and e2e are left for the Stage 12 gate. No storefront page uses these routes yet.

**Owner decision (26 October 2026):** defaults kept: 20 addresses per customer; a verified email is required; deleting the default promotes the newest remaining address.

## 12.04 Implement guest checkout contact input (CHV-S12-M04), 26 October 2026

**Status:** PASS.

**Owner decisions (26 October 2026, asked before building):**

- The only phone is the delivery phone on the address. There is no separate contact phone.
- Marketing sign-up is not offered until the consent wording is approved (Stage 18). A request that says yes is refused and nothing is stored.

**What changed**

- **Route:** `apps/api/src/modules/contact.controller.ts` (new) serves `GET` and `PUT /api/v1/cart/contact`, which the web host reaches as `/api/cart/contact`.
  - Both are `@Access.shopper()` and `no-store`; `PUT` is limited to 20 a minute.
  - The controller is registered before the cart controller, so `contact` is not read as a cart id.
  - It sits under the bag rather than a `/checkout` path because it places no order: the Stage 10 and 11 gates ("no checkout or payment path") still hold unchanged.
- **Rules** (`apps/api/src/checkout/contact.ts`, new):
  - **Bag:** only the shopper's own current bag. No bag (or a made-up guest token) is 404 and starts no guest session; an empty bag is 409.
  - **Email:** a guest gives it (trimmed, lower-cased, at most 254 characters). A customer's is the account email, and a different one is refused.
  - **Address:** checked by `parseIndianAddress`, every problem named under `shippingAddress.<field>`, and nothing partial stored. It is stored as a snapshot on the bag, never in an address book.
  - **No account:** nothing creates a user, sign-in, order or reservation.
- **Table** `cart_contact` (migration `20261026030000_cart_contact`, rollback included, applied locally):
  - one row per bag, deleted with the bag
  - CHECK constraints for a lower-case email and an address object with the mandatory keys, a valid PIN, an E.164 mobile and `IN`
  - `schema.prisma` gains `CartContact`
- **Supporting changes:**
  - `apps/api/src/cart/merge-apply.ts` deletes the guest bag's contact details at the sign-in merge; they are not carried to the account.
  - `apps/api/src/cart/ownership.ts`: the owner lock is now the shared `lockCartOwner`, used by `openCart` and the contact step. Behaviour is unchanged; the cart suites pass.
  - Contract: `CheckoutContactV1` (additive).
  - OpenAPI regenerated: the only addition is `/api/v1/cart/contact`, and no existing path changed.
  - `tests/integration/database/schema.test.mjs` now expects 38 tables, including `cart_contact`.

**Test:** `tests/security/checkout/guest-contact.test.mjs`, 10 tests (log `stage-12-04-guest-contact.log`):

- a guest with a bag saves email and address, reads them back and changes them, with no user, account, verification, order, reservation or address-book row created
- invalid or missing fields are all named and nothing is stored
- marketing yes (`true`, `"yes"`, `1`) is refused and nothing is stored; `false` or absent is fine
- no bag or a forged guest cookie gives 404 with no guest session started
- an emptied bag gives 409; another site gives 403
- two guests never see or change each other's details
- the database refuses malformed rows
- a customer's email is the account email
- sign-in merges the bag and deletes the guest details

Command: `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/support/register.mjs --test tests/security/checkout/guest-contact.test.mjs` after `npm run build:api`. Result: 10 of 10 pass. The first run failed 1 because of a wrong count in the test itself (it expected 2 rows where one bag was involved); the test was corrected.

**Mutation checks** (each undone afterwards; the restored run passes 10 of 10):

| Mutation | Tests failing |
|---|---|
| Marketing yes accepted | 1 |
| Guest email not required | 5 |
| Merge keeps guest details | 1 |
| Empty bag accepted | 1 |

**Wider runs:**

| Check | Result |
|---|---|
| `npm run test:db` | 61 of 61 (after the table count update; the first run failed only on the old count of 37) |
| `npm run test:security` | 326 of 326 |
| `npm test` | 95 of 95 |
| `npm run build` | passes |
| `npm run test:e2e` | 58 of 58 (the Stage 10 and 11 gates still find no checkout or payment path) |
| `npm run typecheck` | clean |
| `npm run lint` | 0 errors, the 2 existing warnings |

There is no storefront contact page yet (Stage 12.11 builds the checkout review UI), so there was nothing to check in a browser.

## 12.05 Define tax policy configuration (CHV-S12-M05), 26 October 2026

**Status:** PASS. No tax rate, HSN code or GSTIN was invented: no profile exists until the owner enters real values. Every value in the tests is synthetic.

**What changed**

- **Tax profile** (`apps/api/src/tax/profile.ts`, new). It holds:
  - the seller state (ISO 3166-2:IN)
  - the GSTIN, checked for format, check character, and its first two digits against the seller state's GST code
  - whether prices include GST (decision 014, still proposed)
  - for each tax category, an HSN code (4, 6 or 8 digits) and a GST rate (0% to 40% in whole basis points)
- **Life cycle:**
  - **Draft:** created and edited by the owner.
  - **Approved:** the owner signs a complete draft with three things: the statement that a qualified tax advisor checked it, the advisor's reference, and a typed full name. "Complete" means a GSTIN, at least one rate, and a rate for every tax category on a sellable variant; a sellable variant with no tax category also blocks approval.
  - **Active:** only an approved profile can be activated. Activating one retires the previous; only one is active at a time, even under parallel requests.
  - **Audit:** every step is recorded (`tax_profile.created`, `.updated`, `.approved`, `.activated`; approving and activating need a reason).
- **Live-sales gate:**
  - `taxReadiness` lists what blocks selling: no active approved profile, a sellable variant with an unassigned category, or a category missing from the active profile.
  - `assertTaxReadyForSale` refuses with 409 until those are cleared; checkout must call it before taking an order (12.09 and later).
  - `taxProfileFor`: in production only the active approved profile is ever used, never a draft. Elsewhere a draft can be used for test quotes and is marked `approved: false`.
- **Routes** (`apps/api/src/modules/tax.controller.ts`, new): `/api/v1/admin/tax/profiles` (GET, POST), `/profiles/:id` (PUT), `/profiles/:id/approve`, `/profiles/:id/activate` and `/readiness`. All are owner-only (`settings.manage`), admin-host only, and no-store.
- **Database** (migration `20261026040000_tax_profile` with rollback, applied locally): new tables `tax_profile` and `tax_rate`.
  - CHECK constraints: an approved or retired profile must carry its approver, time, signature, advisor reference and GSTIN; only an approved profile can be active; GSTIN, HSN, category and rate formats are enforced.
  - The partial unique index `tax_profile_one_active` allows one active profile.
  - The trigger `tax_profile_frozen` means an approved or retired profile's values and rates never change, it is never deleted, and a retired profile never returns.
- **Other files:**
  - audit actions added in `packages/contracts/src/modules/audit.ts` and `apps/api/src/audit/catalogue.ts`
  - `schema.prisma` gains `TaxProfile` and `TaxRate`
  - OpenAPI regenerated: only the 5 tax paths are added; no existing path changed
  - `tests/integration/database/schema.test.mjs` now expects 40 tables

**Test:** `tests/security/tax/profile.test.mjs`, 12 tests (log `stage-12-05-tax-profile.log`):

- with no profile, sales are blocked and production has nothing to use
- a draft cannot be activated and production never falls back to it
- the database refuses an active or approved profile that was never signed
- only the owner may draft, approve, activate or read readiness: admin and staff get 403, signed out gets 401
- approval needs the statement, the reference, the name and a reason
- an incomplete profile is refused: no GSTIN, no rates, or a missing category
- GSTIN check character and state are enforced, and a widely published sample GSTIN passes the check-character test
- rate validation works
- a signed profile becomes approved then active, production uses it, and the audit trail reads created, approved, activated
- an approved profile cannot be edited, re-rated or deleted
- a new sellable category blocks sales again
- parallel activations leave exactly one active profile, retire the others, and a retired profile cannot return

Command: `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/support/register.mjs --test tests/security/tax/profile.test.mjs` after `npm run build:api`. Result: 12 of 12 pass. The first run failed 1 because the test sorted audit rows by a field name that does not exist (`createdAt` instead of `occurredAt`); the test was corrected.

**Mutation checks** (each undone afterwards; the restored run passes 12 of 12):

| Mutation | Tests failing |
|---|---|
| Activation skips the approval check | 1 |
| Database allows an active draft | 4 |
| Production falls back to a draft | 1 |
| Approval ignores sellable categories | 4 |
| Rates of an approved profile editable | 1 |

**Wider runs:**

| Check | Result |
|---|---|
| `npm run test:db` | 61 of 61 |
| `npm run test:security` | 338 of 338 |
| `npm test` | 95 of 95 |
| `npm run typecheck` | clean |
| `npm run lint` | 0 errors, the 2 existing warnings |
| `npm run build` | passes on the second run; the first run's failure was not captured |
| `npm run test:e2e` | 58 of 58, rerun on the fresh build |

**Owner decision (26 October 2026):** the business will be GST registered, so approval keeps requiring a GSTIN.

**For the owner and the tax advisor (not decided here):**

- the real GSTIN and seller state
- HSN codes and GST rates per category
- whether prices include GST (decision 014)
- invoicing

There is no admin page for this yet; only the API exists.

## 12.06 Implement server-side tax computation (CHV-S12-M06), 27 October 2026

**Status:** PASS.

**Owner decisions (27 October 2026, asked before building).** The tax advisor should confirm them with the worked examples below.

- **Rounding:** per line, to the nearest paisa, half up; the bag's tax is the sum of its lines.
- **Within the seller's state:** CGST and SGST are each worked out at half the rate and rounded separately, so they are always equal.
- **Bag discount:** shared across lines in proportion to their price, in whole paise, with left-over paise going to the largest remainders (ties to the earlier line). Tax is charged on the discounted price.

**What changed**

- `apps/api/src/tax/compute.ts` (new) does the arithmetic. It is pure (no database, no browser amounts) and uses `bigint` paise only, with no floating point.
  - **Supply:** delivery in the seller's state gives CGST plus SGST, or CGST plus UTGST where the seller is in a union territory without a legislature (Andaman and Nicobar, Chandigarh, Dadra and Nagar Haveli and Daman and Diu, Lakshadweep, Ladakh). Delivery to any other state gives IGST.
  - **GST-inclusive prices:** the shopper pays exactly the discounted price; each half is `round(V x r / (2 x (10000 + r)))`, IGST is `round(V x r / (10000 + r))`, and the taxable value is `V` minus the tax.
  - **Prices before tax:** the tax is added on top.
  - **Refusals:** a category with no rate, a bad state, a discount larger than the bag, or a bad quantity is refused and never taxed at zero.
- **Classification:** every line returns a `TaxClassificationV1` for the quote and order to freeze: profile id, whether the profile was approved, category, HSN code, rate, supply, seller and delivery states, whether prices include tax, and the rounding policy version `line_half_up_v1`.
- `apps/api/src/tax/profile.ts`: `taxForBag` uses the profile this environment may use. In production that is only the active approved profile, otherwise 409 "sales closed"; elsewhere a draft is allowed, marked unapproved.
- **Contracts** (`packages/contracts/src/modules/money.ts`): `TaxComponent` gains `UTGST`, and there is a new `TaxClassificationV1`. Both are additive.
- There is no route, table or page in this step. The quote calculator (12.09) will use `taxForBag`.

**Worked examples.** Synthetic rates and HSN codes, not tax advice. All amounts are in rupees; prices include GST unless stated; seller in Karnataka.

| # | Bag | Discount share | Taxable | Tax | Line total |
|---|---|---|---|---|---|
| E1 | 1,899.00 at 5%, delivered in Karnataka | 0 | 1,808.58 | CGST 45.21 + SGST 45.21 | 1,899.00 |
| E2 | the same line, delivered to Maharashtra | 0 | 1,808.57 | IGST 90.43 | 1,899.00 |
| E3 | 1,899.00 at 5%, plus 2 x 999.00 at 12%, 100.00 off the bag | 48.73 / 51.27 | 1,762.17 / 1,738.15 | 44.05 + 44.05 / 104.29 + 104.29 | 1,850.27 / 1,946.73 (bag 3,797.00) |
| E4 | E3's bag priced before tax, delivered to Maharashtra | 48.73 / 51.27 | 1,850.27 / 1,946.73 | IGST 92.51 / 233.61 | 1,942.78 / 2,180.34 (bag 4,123.12) |
| E5 | 1.00 at 0.25%, plus 3 x 9.99 at 3% | 0 | 1.00 / 29.09 | 0 + 0 / 0.44 + 0.44 | 1.00 / 29.97 |
| E6 | three lines of 1.00 at 5%, 0.02 off | 0.01 / 0.01 / 0 | 0.95 / 0.95 / 0.96 | 0.02 + 0.02 each | 0.99 / 0.99 / 1.00 |

In E1 and E2 the same line carries 0.01 more tax as IGST than as CGST plus SGST, because the two halves are rounded separately.

**Test:** `tests/security/tax/compute.test.mjs`, 13 tests (log `stage-12-06-tax-compute.log`). The examples above were worked out separately in plain integer arithmetic, not by the module under test.

- the six worked examples, and UTGST versus SGST (Delhi has a legislature)
- the same input gives the same result 50 times
- 200 generated bags, each priced both with and without GST included: every amount is a non-negative bigint, line totals add up to the bag, discounts add up exactly, an inclusive line costs exactly its discounted price, and CGST always equals SGST
- the half-up and allocation edge cases
- refusals (unmapped category, bad state, discount over the bag, bad quantity, bad seller state)
- the classification snapshot
- with the database: production refuses without an approved active profile and never uses a draft, while development uses a draft marked unapproved

Command: `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/support/register.mjs --test tests/security/tax/compute.test.mjs` after `npm run build:api`. Result: 13 of 13 pass. The first run failed 1 because the test itself shared 10 paise over a total weight of 3, which the function correctly refuses; the case was corrected.

**Mutation checks** (each undone afterwards; the restored run passes 13 of 13):

| Mutation | Tests failing |
|---|---|
| Rounding down instead of half up | 5 |
| Tax on the price before discount | 4 |
| Left-over paise to the smallest remainders | 2 |
| IGST never used | 3 |
| UTGST never used | 1 |

**Wider runs:**

| Check | Result |
|---|---|
| `npm run test:db` | 61 of 61 |
| `npm run test:security` | 351 of 351 |
| `npm test` | 95 of 95 |
| `npm run typecheck` | clean |
| `npm run lint` | 0 errors, the 2 existing warnings |

Build and e2e are left for the Stage 12 gate: this step adds no route, page or table.

**Not decided here:** GST on the shipping fee belongs to the quote (12.09) and needs the tax advisor; invoice rounding to whole rupees, if any, is also the advisor's call.

## 12.07 Define courier rate interface (CHV-S12-M07), 27 October 2026

**Status:** PASS. No courier is connected: this step defines the contract and the server-side checks, which are tested against fake couriers.

**What changed**

- **Contract** (`packages/contracts/src/integrations/courier-gateway.ts`, additive):
  - `RateRequestV1`: pickup PIN, delivery PIN and state, one `RateParcelV1`, and payment mode `prepaid` only, because cash on delivery is not decided.
  - `RateParcelV1`: weight in grams, packed size or `null`, declared value in paise, the restrictions in the parcel (`ShippingRestrictionV1`: `fragrance_liquid`, `jewellery_high_value`), and the SKUs.
  - `CourierRateOptionV1`: an offer with its own limits: air or surface, maximum weight, maximum declared value, and which restrictions it accepts.
  - `RateQuoteV1`: either `available` with offers, or `unavailable` with a reason (`pin_unserviceable`, `category_restricted`, `parcel_unsupported`, `provider_unavailable`) and an empty option list by type.
  - `CourierGateway.quoteRates`: the new interface method. No adapter exists yet.
- **Server checks** (`apps/api/src/shipping/rates.ts`, new, pure):
  - `parcelFor` builds the parcel from catalogue data. A line with no weight, a zero weight, an unreviewed or unknown restriction, or a bad quantity makes the parcel unsupported, so it is never quoted. There is no default weight, box or packaging allowance.
  - `acceptQuote` keeps only offers the courier itself made that fit this exact parcel: an INR rate in whole, non-negative paise, a weight and value limit at or above the parcel's, every restriction in the parcel accepted, a valid service reference, courier name, mode, delivery estimate and quote time. Offers are copied, and sorted cheapest first with a stable tie order.
  - If no offer survives, the quote is unavailable: `category_restricted` when the only reason was a restriction, `parcel_unsupported` otherwise.
  - The courier's own unavailable answer stays unavailable, and any options attached to it are discarded. An unknown status or reason becomes `provider_unavailable`.
  - `quoteParcel` asks the gateway with a 5-second timeout. A throw, a timeout or a malformed answer gives `provider_unavailable` and no offer.
  - `rateRequest` refuses a malformed pickup PIN, delivery PIN or state.

**Test:** `tests/security/shipping/rates.test.mjs`, 10 tests (log `stage-12-07-courier-rates.log`):

- parcel weight, value and restrictions are built from the lines
- a missing weight, an unreviewed restriction or an unknown restriction gives no parcel
- a bad address gives no request
- real offers pass unchanged, cheapest first
- an offer that is too heavy or too valuable is dropped and the parcel is unsupported
- perfume is never offered a service that does not accept liquids; mixed parcels need every restriction accepted
- 14 malformed or made-up offers are dropped (USD, fractional, negative or text paise, missing fields, unknown mode, bad date, a string "free shipping")
- an unavailable answer with attached options gives none
- offers are copies of the courier's
- a courier throw, timeout or nonsense answer gives no offer, and the courier is asked about exactly this parcel

Command: `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/support/register.mjs --test tests/security/shipping/rates.test.mjs` after `npm run build:api`. Result: 10 of 10 pass.

**Mutation checks** (each undone afterwards; the restored run passes 10 of 10):

| Mutation | Tests failing |
|---|---|
| Restricted items offered any service | 1 |
| Weight limit ignored | 1 |
| Missing weight treated as zero | 1 |
| Any currency accepted | 1 |

**Wider runs:**

| Check | Result |
|---|---|
| `npm run test:db` | 61 of 61 |
| `npm run test:security` | 361 of 361 |
| `npm test` | 95 of 95 |
| `npm run typecheck` | clean |
| `npm run lint` | 0 errors, the 2 existing warnings |

Build and e2e are left for the Stage 12 gate: this step adds no route, page or table.

**Not decided here (owner):**

- the pickup address and PIN
- packaging: box sizes, and any weight allowance for packing
- whether cash on delivery is offered
- which courier account to use (Shiprocket is named in the contract)
- how a parcel above a courier's limits is split

## 12.08 Implement sandbox courier availability (CHV-S12-M08), 27 October 2026

**Status:** PASS. A sandbox courier answers delivery and rates in development and staging. Its answers are always test answers: the bag labels them as test rates, and they never make a bag deliverable or eligible to ship. Production has no courier yet, so it shows no rates.

**What changed**

- **Sandbox courier** (`apps/api/src/shipping/sandbox-courier.ts`, new). Deterministic, with no randomness, no network and an injected clock:
  - Provider `sandbox`, mode `test`. It only answers `checkServiceability` and `quoteRates`; every other courier method refuses.
  - A delivery PIN ending in 999 is unserviceable, and one ending in 998 simulates an outage. Every other well-formed PIN is serviceable.
  - Zones are counted from the synthetic pickup PIN 560001: local, regional or national.
  - Prices are a zone base plus a fixed amount for each extra 500 g slab.
  - Surface carries up to 20 kg and accepts fragrance. Air carries up to 5 kg and accepts no restricted item. Neither accepts jewellery, and both carry goods worth up to Rs 50,000.
  - Service references start `sandbox:`. Its answers still go through `acceptQuote` (12.07).
- **Test kept apart from live** (`apps/api/src/shipping/courier.ts`, new):
  - `courierFor(env)` uses the sandbox in development and staging. Production only takes a live, non-sandbox courier, and none exists yet, so production gives mode `none`. A sandbox or test-mode courier handed to production is refused.
  - `shippingRatesFor` reads the shopper's own bag and saved contact address. The parcel comes from catalogue weights, prices and restrictions.
  - The result is `ShippingRatesV1`: `mode` (`test`, `live` or `none`), the delivery check, the quote, and `liveEligible`. `liveEligible` is true only for a live courier's serviceable answer with offers.
  - A live answer that contains a `sandbox:` service is not trusted. A PIN the courier doesn't serve gets no rates. Nothing is booked, reserved or stored.
- **Delivery check** (`apps/api/src/checkout/region.ts`): `DeliveryCheckV1` gains `source` (`none`, `test` or `live`). A test answer shows what the sandbox said, but `deliverable` stays false. The 12.02 test now expects the new field.
- **Route** `GET /api/v1/cart/shipping-rates` (`apps/api/src/modules/shipping.controller.ts`, registered before the cart controller):
  - shopper access, no-store, 30 calls a minute
  - 404 with no bag, 409 for an empty bag or no delivery address
  - query parameters are ignored, so the browser cannot choose the courier or the parcel
  - added to OpenAPI (62 paths)
- **Contracts:** `ShippingRatesV1`; `CourierGateway.provider` also allows `sandbox`; `DeliveryCheckV1.source`.
- **Bag drawer** (`lib/shipping-rates.ts`, `components/cart/shipping-estimate.tsx`, `components/cart/cart-sheet.tsx`):
  - Once a delivery address is saved, the drawer shows delivery above the promo code.
  - Test rates appear in a dashed block headed "Delivery (test rates)", with a "Test rates" badge and the line "They are not real delivery prices, and nothing can be shipped at them".
  - Each price carries "Test rate", and the delivery line starts "Simulated:".
  - The label follows the API's `mode` alone. Live rates carry no test wording. With no courier, nothing is shown.
  - Screenshot: `stage-12-08-bag-test-rates.jpg`.

**Test:** `tests/security/shipping/sandbox-courier.test.mjs`, 13 tests (log `stage-12-08-sandbox-courier.log`):

- the same request always gets the same answer
- zone and slab prices are as documented
- the documented PINs give an unserviceable address and an outage
- other courier work is refused
- sandbox answers still pass the server's checks: perfume never goes by air, jewellery has no service, an oversize parcel is unsupported
- development and staging pick the sandbox; production never does, even when handed one
- over HTTP, the bag gets test rates with delivery source `test`, `deliverable` false and `liveEligible` false, and no order, reservation or shipment is created
- catalogue data decides the parcel: perfume, jewellery and unweighed items
- an unserviceable PIN or an outage gives no rate
- no bag gives 404, no address gives 409, and query tampering changes nothing
- only a fake live courier makes a bag eligible, and a live answer with a sandbox service is refused
- the bag shows a badge, a notice and a label on every test price, and no test wording on live prices
- a test answer dressed as live is still shown as a test
- with no courier nothing is shown, and when there is no rate the reason is shown instead of a price

Command: `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/support/register.mjs --test tests/security/shipping/sandbox-courier.test.mjs` after `npm run build:api`. Result: 13 of 13 pass. Run together with `pin-state` and `rates`: 31 of 31.

**Mutation checks** (each undone afterwards; the restored run passes 13 of 13):

| Mutation | Tests failing |
|---|---|
| Sandbox allowed in production | 1 |
| A test answer makes a PIN deliverable | 2 |
| Eligibility ignores test mode | 3 |
| A sandbox service trusted in a live answer | 1 |
| Sandbox uses the wall clock | 1 |
| Prices lose the test label | 2 |
| The label trusts `liveEligible` instead of `mode` | 1 |

**Wider runs:**

| Check | Result |
|---|---|
| `npm run test:security` | 374 of 374 |
| `npm run test:db` | 61 of 61 |
| `npm test` | 95 of 95 |
| `npm run typecheck` | clean |
| `npm run lint` | 0 errors, the 2 existing warnings |
| `npm run build` | passes (the first run stopped at the Next.js upgrade notice, as in 12.05; the retry passed) |
| `npm run test:e2e` | 58 of 58 |

**Browser check** (dev server, port 5601): a guest bag with a saved address showed the test-rate block, with "Sandbox Surface · about 2 days, TEST RATE ₹50" and "Sandbox Air · about 1 day, TEST RATE ₹90". On a phone-width screen, the no-rate state kept the test label and gave the reason.

No product in the dev database has a weight yet. One variant was given 600 g for the screenshot and set back to empty afterwards. The console errors were the known local image 404s.

**Not decided here (owner):**

- the real pickup address and PIN; the sandbox uses a synthetic 560001
- packaging allowance, cash on delivery and the courier account
- product weights, which every product needs before a real rate can be given
- the header still says "Free shipping across India", template copy that conflicts with paid delivery rates; the owner should confirm the shipping offer

## 12.09 Build checkout quote calculator (CHV-S12-M09), 27 October 2026

**Status:** PASS. The server now prices the whole bag: catalogue prices, the applied promotion, the courier's delivery offer and GST, including GST on the delivery fee. Nothing the browser sends is used as an amount. A quote places no order, takes no payment and reserves no stock.

**Owner decisions, 27 October 2026** (the tax advisor still has to confirm the first):

- **GST on the delivery fee:** the fee is shared across the lines in proportion to their value after discount, and each share is taxed at its line's GST rate. The fee follows the price setting: with GST-inclusive prices it includes GST, otherwise GST is added.
- **Delivery option:** the shopper picks one of the courier's offers by its reference, and the price always comes from the server. With no pick, the cheapest offer is used.

**What changed**

- **Tax maths** (`apps/api/src/tax/compute.ts`): `computeTax` takes an optional `shippingFeePaise` and returns `shipping` with the fee's shares, GST and total.
  - The split uses the same largest-remainder rule as the discount, in whole paise. A fee larger than the goods still splits.
  - A fully discounted bag shares the fee by list price.
  - A negative fee is refused.
  - Earlier results are unchanged; the 12.06 test passes 13 of 13.
- **Quote** (`apps/api/src/checkout/quote.ts`, new): `quoteBag` prices the shopper's own current bag.
  - Prices come from the live catalogue (`readCart`), and the promotion is checked again.
  - Tax category and stock are read now: a line needs counted stock with enough units available.
  - Delivery uses the courier's offers for the saved address (12.08), and GST comes from the tax profile (12.05, 12.06).
  - The body may carry only `serviceRef` and `cartRevision`; every other field is ignored.
  - The grand total must add up from its parts, or the quote fails with an error instead of a price.
  - Refusals:
    - 404: no bag
    - 409: empty bag; unavailable or short-stocked items; no address; no courier or no offer; no usable tax profile; stale revision
    - 400: an offer that wasn't made
  - The quote is mode `test`, with `testReasons`, when delivery used sandbox rates or the tax profile is unapproved.
  - It is stored as the bag's only quote, under the bag's row lock and only if the bag hasn't changed since it was priced. It expires after 15 minutes.
- **Route** `POST /api/v1/cart/quote` (`apps/api/src/modules/quote.controller.ts`, registered before the cart controller): shopper access, no-store, 20 calls a minute. Added to OpenAPI (63 paths).
- **Contract** `CheckoutQuoteV1` (`packages/contracts/src/modules/checkout.ts`): `QuoteV1` without `owner`, plus each line's title and tax classification, the chosen delivery option with its GST, the supply type, `mode` and `testReasons`. The shopper's identity is never returned.
- **Table** `checkout_quote` (migration `20261027000000_checkout_quote`, rollback in `apps/api/prisma/rollback/`):
  - one row per bag, removed with the bag
  - checks: whole-paise INR, a stored total that matches the stored quote, and an expiry after creation
  - the schema test now expects 41 tables
- **Earlier gate tests:**
  - **The clash:** `tests/e2e/cart-gate.test.mjs` (Stage 11) and `tests/e2e/catalogue-gate.test.mjs` (Stage 10) refused any API path containing "quote". The Stage 10 test says quotes stay closed "until their own stages", and this is that stage.
  - **The change:** both now allow exactly `/api/v1/cart/quote` and still refuse every other checkout, payment, webhook or quote path.

**Test:** `tests/security/checkout/quote.test.mjs`, 13 tests (log `stage-12-09-checkout-quote.log`):

- **A local Karnataka quote adds up:**
  - ₹1,899.00 plus the ₹30.00 sandbox fee is ₹1,929.00
  - goods CGST and SGST are 45.21 each; the fee's CGST and SGST are 0.71 each
  - it is mode test, with both reasons, and no order or reservation is created
- **Inter-state** to Maharashtra is IGST on goods (90.43) and fee (4.29), with the air option the shopper picked.
- **Discount:** a 10% promotion's discount comes from the server.
- **Catalogue price:** a price change shows in the next quote.
- **Tampering:**
  - The body sent grand total 1, subtotal 1, discount 999999, fee 0, tax 0, a line price of 1, `pricesIncludeTax: false`, a made-up code, `mode: "live"` and USD, plus the same in the query string and headers.
  - The quote came back identical to the honest one, and the stored total is the server's.
- **Delivery option:** an option the courier didn't offer is refused (400), never priced.
- **Stale bag:** an old bag revision is refused (409).
- **Parallel quotes:** they leave exactly one stored row, and it is one of theirs; a new quote replaces the old.
- **Bags that can't be sold as they are:** no bag, no address, stock taken after adding, uncounted stock, a withdrawn item and an empty bag are all refused.
- **Production:** it has no courier, and it never uses a draft tax profile, even with a live courier.
- **Fee split:**
  - ₹100.01 split 25.00 and 75.01 across 5% and 12% lines, with 1.25 and 9.00 IGST added when prices exclude GST
  - an inclusive fee includes its GST
  - a fully discounted bag splits by list price
  - a zero fee adds nothing, and a negative fee is refused

Command: `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/support/register.mjs --test tests/security/checkout/quote.test.mjs tests/security/tax/compute.test.mjs` after `npm run build:api`. Result: 26 of 26 pass (13 new, 13 from 12.06).

**Mutation checks** (each undone afterwards; the restored run passes 13 of 13):

| Mutation | Tests failing |
|---|---|
| Unit price read from the body | 1 |
| Delivery fee read from the body | 1 |
| Discount read from the body | 1 |
| An option the courier didn't offer is accepted | 1 |
| Stale revision ignored | 1 |
| Stock not checked | 1 |
| No GST on the delivery fee | 3 |
| Test delivery rates marked live | 1 |

The second revision check, made under the row lock while storing, has no mutation of its own. The parallel-quote test covers storage but not a bag changing between pricing and storing.

**Wider runs:**

| Check | Result |
|---|---|
| `npm run test:security` | 387 of 387 |
| `npm run test:db` | 61 of 61 |
| `npm test` | 95 of 95 |
| `npm run typecheck` | clean |
| `npm run lint` | 0 errors, the 2 existing warnings |
| `npm run build` | passes |
| `npm run test:e2e` | 58 of 58, after the two gate tests were narrowed (first run 56 of 58, both failures the quote path) |

The dev database has the new migration applied, and the dev API was restarted on the new build. There is no storefront page for the quote yet.

**Defaults set here (owner to confirm):**

- the delivery fee is the courier's quoted price, with no markup and no free-delivery rule; the header's "Free shipping across India" still conflicts
- a quote lasts 15 minutes
- only the latest quote per bag is kept

**Not decided here:** the advisor's sign-off on GST for the delivery fee and on the 12.06 examples, and the real GST values.

## 12.10 Introduce quote expiry and fingerprint (CHV-S12-M10), 27 October 2026

**Status:** PASS. A stored quote is bound to its owner, its bag and everything it was priced from, and it lasts 15 minutes. Once it expires or anything it was priced from changes, it is refused with what changed and discarded, so it can never become valid again.

**What changed**

- **Fingerprint** (`apps/api/src/checkout/quote-fingerprint.ts`, new, pure): SHA-256 over a version, the owner digest, one digest per part and the grand total. The parts:

  | Part | What it covers |
  |---|---|
  | cart | bag id, revision, each line's variant, SKU and quantity |
  | price | catalogue unit prices and subtotal |
  | promotion | the applied code and each line's discount |
  | address | delivery PIN and state |
  | delivery | offer reference, courier, mode, fee and total, and whether rates were test or live (the rate version) |
  | tax | each line's classification (profile, category, HSN, rate, supply, rounding), every tax line, the fee's tax and the tax total |

  - The owner is stored only as a namespaced digest of the guest session or customer id, never the id itself.
  - Titles, photos and delivery-day estimates are not bound, because they don't change what is charged.
- **Quote** (`apps/api/src/checkout/quote.ts`):
  - Pricing is split out (`priceBag`), so a stored quote can be priced again exactly as it was quoted.
  - `quoteBag` stores the owner digest, fingerprint, version and part digests with the quote.
  - `checkQuote` checks a stored quote:
    - **Not the owner's:** another shopper's quote, an unknown or malformed id, a replaced quote, or a different fingerprint version is 404.
    - **Expired:** at or past `expiresAt` it is 409 quote `expired`.
    - **Changed:** the bag is priced again with the same delivery option and revision; a different fingerprint is 409 quote `changed`, naming the parts that changed. A pricing refusal maps to its part: stale revision or empty bag to `cart`, short or withdrawn stock to `stock`, then `address`, `delivery` or `tax`.
    - **Discarded:** an expired or changed quote is deleted. Checking a valid quote changes nothing.
- **Route** `GET /api/v1/cart/quote/{quoteId}`: shopper access, no-store, 30 calls a minute. Stage 13 confirmation will use this check. OpenAPI now has 64 paths.
- **Table:** migration `20261027010000_quote_fingerprint`, with rollback, adds `owner_hash`, `fingerprint`, `fingerprint_version` and `parts`.
  - Checks require hex SHA-256 digests and all six parts.
  - Quotes stored before the change are removed rather than given a made-up binding. They last only 15 minutes, and the dev database had none.
- **Gate tests:** `tests/e2e/cart-gate.test.mjs` and `tests/e2e/catalogue-gate.test.mjs` also allow the check path. Every other checkout, payment, webhook or quote path is still refused.
- **Schema formatting:** `prisma format` had realigned 47 lines in models this stage doesn't touch and switched the file to LF. Those lines got their original spacing back, CRLF was restored, and the schema now differs from the last commit only by Stage 12's additions.

**Test:** `tests/security/checkout/quote-validity.test.mjs`, 16 tests (log `stage-12-10-quote-validity.log`):

- **Unchanged quote:**
  - it is valid on repeated and parallel checks, and checking changes nothing
  - the owner id is not stored with it, and the binding is never sent to the browser
- **Expiry:**
  - it lasts exactly 15 minutes: valid 1 ms before expiry, refused at expiry, then discarded
  - turning the clock back doesn't bring it back
- **Titles:** a title change doesn't invalidate it.
- **Owner and replacement:**
  - another guest, no session, an unknown id, a malformed id and an SQL-looking id all get 404, and the owner can still use it
  - a newer quote makes the old id 404
  - after signing in, the guest's quote no longer belongs to the shopper
  - a changed fingerprint version never matches
- **Changes** (each refused with the part named, then discarded, then 404):
  - bag quantity or another item (`cart`)
  - catalogue price (`price`, `tax`, not `cart`)
  - promotion stops applying (`promotion`)
  - address (`address` only)
  - heavier parcel (`delivery` only)
  - tax rate (`tax`)
  - stock taken or item withdrawn (`stock`)
- **Recovery:** after a refusal, a new quote is priced from the new inputs and is valid.
- **Fingerprint unit:**
  - the same inputs give the same fingerprint
  - each part, the address, the owner, the test or live rate version, and the grand total each change it

Command: `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/support/register.mjs --test tests/security/checkout/quote-validity.test.mjs tests/security/checkout/quote.test.mjs` after `npm run build:api`. Result: 29 of 29 pass (16 new, 13 from 12.09).

**Mutation checks** (each undone afterwards; the restored run passes 16 of 16):

| Mutation | Tests failing |
|---|---|
| Expiry not checked | 1 |
| Still valid at the expiry instant | 1 |
| Owner not checked | 2 |
| Fingerprint not compared | 6 |
| A refused quote is kept | 9 |
| Fingerprint version not checked | 1 |
| Address not bound | 2 |
| Owner not in the fingerprint | 1 |
| Test or live rates not bound | 1 |
| Prices not bound as their own part | 3 |

**Wider runs:**

| Check | Result |
|---|---|
| `npm run test:security` | 403 of 403 |
| `npm run test:db` | 61 of 61 |
| `npm test` | 95 of 95 |
| `npm run typecheck` | clean |
| `npm run lint` | 0 errors, the 2 existing warnings |
| `npm run build` | passes |
| `npm run test:e2e` | 58 of 58 |

The dev database has the migration applied, and the dev API runs the new build.

**Defaults set here (owner to confirm):**

- an expired or changed quote is discarded rather than kept for history
- a change is reported by part name only (cart, price, promotion, address, delivery, tax, stock), never with the old and new values

**Not decided here:** nothing new. Stage 13 has to call `checkQuote` at confirmation and compare the shopper's expected total.

## 12.11 Build checkout review UI (CHV-S12-M11), 27 October 2026

**Status:** PASS. Development and staging have an order review page at `/checkout`: delivery address, delivery options and an itemised INR summary, in the storefront's warm editorial style. Every figure on it is the API's quote, formatted and never recalculated. It places no order: the final button stays disabled until payments (Stage 13).

**Owner decision, 27 October 2026:**

- The review page is open in development and staging only, and the bag links to it there.
- In production `/checkout` is 404 and the bag keeps the disabled "Checkout opens soon" button until payments exist.

**What changed**

- **Page** `app/(store)/checkout/page.tsx`:
  - It shows a 404 unless `checkoutReviewOpen(process.env)`, read on every request because the root layout is dynamic.
  - It is never indexed (`noindex, nofollow`).
  - It uses the account-style header: gold-rule eyebrow "Checkout" and the mask headline "Review your order".
- **Review** `components/checkout/checkout-review.tsx` (client), using only the existing cart API through the web host:
  - **Delivery address:** a form on PUT `/api/cart/contact` with email, name, mobile, PIN, address lines, landmark, city, district and a state picker.
    - Each field has a visible label and autocomplete, and the API's errors appear under their own field (`aria-invalid` and `aria-describedby`).
    - Once saved, the address shows as a card with "Change".
  - **Delivery option:** a radio list from GET `/api/cart/shipping-rates`. Sandbox rates carry the "Test rates" badge, the notice, and "Test rate" beside each price (12.08).
  - **Order summary:** the quote from POST `/api/cart/quote` (with the chosen option and the bag revision): lines, subtotal, discount, delivery, GST and total, plus a test-quote notice and the time until which the prices are held. Choosing another option asks the API again.
  - **Refusals:** a quote refusal is shown in plain words (stock, unavailable item, PIN not served, no courier, tax not ready) with no price.
  - **No order:** the button reads "Payment opens soon" and is disabled. Nothing calls an order or payment API.
- **Presentation** `lib/checkout.ts`:
  - `checkoutReviewOpen`, which reads the environment the same way as the API.
  - `reviewSummary`, which only formats the quote's amounts (paise to rupees) and adds nothing up; the total is the quote's `grandTotal`.
  - The 36 state and union territory names for the picker; the API still checks the code.
- **Bag** `components/cart/cart-sheet.tsx` and `app/(store)/store-shell.tsx`: when the review is open and the bag has items, the button is a "Review order" link to `/checkout`; otherwise it is the disabled "Checkout opens soon" button, as before.
- **Earlier gate tests:**
  - **The clash:** `tests/e2e/cart-gate.test.mjs` (Stage 11) and `tests/e2e/catalogue-gate.test.mjs` (Stage 10) required `/checkout` to be 404 on a development server and nothing to link to it.
  - **The change:** `/checkout` was taken off their development 404 lists, with a note. The catalogue gate now lets only the bag link to `/checkout`, and only behind `checkoutOpen`, and it still forbids any checkout API call. Production being closed is tested in the new test against a production server.

**Test:** `tests/e2e/checkout-review.test.mjs`, 7 tests, against the production build with one `next start` as development and one as production (log `stage-12-11-checkout-review.log`):

- **Total through the web host:** with 2 kurtas, a 10% code and sandbox surface delivery, the shown total ₹3,468.20 equals the API's `grandTotal`, the stored quote's total and the quote check. Every row and line amount is the matching quote field.
- **Delivery choice:** choosing air shows the API's new total (₹1,929 surface, ₹1,949 air), and the earlier option's quote is replaced (404).
- **No arithmetic:** a quote whose parts don't add up (grand total ₹1,234.56, rows summing to ₹1) still shows ₹1,234.56. The review code has no money arithmetic, and its Total cell shows `summary.total`.
- **Test quotes and orders:** a test quote says why, nothing on the page can place an order, and no order or reservation exists.
- **Open where:** development serves `/checkout` (not indexed) and production answers 404. The switch is open for development, staging and Vercel preview, and closed for production however it is declared.
- **The bag:** it links to the review only when it is open, and otherwise keeps the disabled button.

Command: `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/support/register.mjs --test tests/e2e/checkout-review.test.mjs` after `npm run build` and `npm run build:api`. Result: 7 of 7. Whole e2e suite: 65 of 65.

**Mutation checks** (each undone afterwards; the restored run passes 7 of 7):

| Mutation | Tests failing |
|---|---|
| Total worked out in the browser from the rows | 1 |
| The Total cell shows the subtotal | 1 |
| Review open in production | 1 |
| Bag links to the review in production | 1 |
| Page not gated | 1 |
| Test quote not marked | 1 |
| Discount row hidden | 1 |

The mutations ran against the existing production build, so the page and bag mutations were caught by the source checks rather than over HTTP.

**Wider runs:**

| Check | Result |
|---|---|
| `npm run test:security` | 403 of 403 |
| `npm run test:db` | 61 of 61 |
| `npm test` | 95 of 95 |
| `npm run typecheck` | clean |
| `npm run lint` | 0 errors, the 2 existing warnings |
| `npm run build` | passes |
| `npm run test:e2e` | 65 of 65 |

**Browser check** (dev server, port 5601; screenshot `stage-12-11-checkout-review.jpg`):

- **Total:** with a temporary 600 g weight on one dev variant and a temporary draft tax profile (synthetic 5%), the page showed the address card, two test-rate options and the summary. The on-screen total matched the API for both options (₹5,549 surface, ₹5,589 air).
- **Phone width:** a malformed PIN flagged only the PIN field, with its error linked to it, and nothing scrolled sideways.
- **Bag:** it showed "Review order" linking to `/checkout`.
- **Clean-up:** the temporary profile and weight were removed afterwards. The page then said delivery can't be priced and showed no price.
- **Afterwards:** the vague "Check this" error was replaced with field-specific wording.

**Defaults set here (owner to confirm):**

- the cheapest delivery option is chosen again when the page is reloaded; the choice isn't remembered
- customers enter their address on the page; saved addresses (12.03) aren't offered as a picker yet
- the phone shows as stored (+91XXXXXXXXXX)
- copy: "Review your order", "Payment opens soon", "These prices are held until ..."

**Not decided here:** the page's copy and the "Free shipping across India" header conflict; both are for the owner.

## 12.12 Implement delivery-serviceability failure UI (CHV-S12-M12), 27 October 2026

**Status:** PASS. When delivery isn't available, the checkout review says why, offers what the shopper can do, and shows no total. Checkout can't go on. A courier that didn't answer is never worded as delivering or as refusing; it gets "could not check" with a retry.

**What changed**

- **Failure mapping** (`lib/checkout.ts`): `deliveryIssue(rates, quoteError)` turns the API's answers into one issue. `canProceed(quote, issue)` is true only with a quote from the API and no issue.

  | Issue | What the shopper sees | Actions |
  |---|---|---|
  | `pin_unserviceable` | "We don't deliver to {PIN} yet", "Check the PIN code, or use another delivery address." | Change address, Contact us |
  | `provider_unavailable` (courier error, timeout, or rates that could not load) | "We couldn't check delivery to {PIN} just now", "This doesn't tell us whether we can deliver there, so try again in a moment." | Try again, Contact us |
  | `category_restricted` | "Something in your bag can't be sent to {PIN}" | Edit bag, Change address |
  | `parcel_unsupported` (no weight on an item) | "We can't price delivery for this bag yet" | Contact us, Edit bag |
  | `no_courier` (production today) | "Delivery isn't available yet" | Contact us |

  A quote refusal (`shipping` field) overrides an earlier rates answer. Stock and availability problems are not delivery issues and keep their own message.
- **Review page** (`components/checkout/checkout-review.tsx`):
  - The issue replaces the delivery options in a sand card with an alert icon, `role="alert"` and the action links.
  - **Change address** opens the address form. **Try again** asks the API again for rates and quote. **Edit bag** opens the bag drawer, and **Contact us** goes to `/contact`.
  - While an issue stands, the summary shows no total ("Your total appears once delivery is available for this address.").
  - The order button stays disabled and carries `data-can-proceed`, for Stage 13 to build on.
- **API:** no change. It already refuses a quote for every failure (12.07 to 12.10) and stores nothing.

**Test:** `tests/security/checkout/delivery-failure.test.mjs`, 10 tests, through the web host's forwarder as the review page calls it (log `stage-12-12-delivery-failure.log`):

- **Unserviceable PIN** (110999): no option, quote refused (409, `pin_unserviceable`), nothing stored. The issue is "We don't deliver to 110999 yet" with Change address and Contact us, and checkout can't go on.
- **Courier outage** (110998):
  - quote refused (`provider_unavailable`); the issue is "couldn't check delivery to 110998" with Try again and Contact us
  - the wording makes no claim either way
  - a true retry with a courier that failed once then answered gets the courier's real offer and can go on
- **Restricted item** (jewellery): refused (`category_restricted`), with Edit bag and Change address.
- **Item with no weight:** refused (`parcel_unsupported`), with Contact us and Edit bag.
- **Served address:** a quote, no issue, and the total ₹1,959.
- **Address moved:** moving a quoted bag to an unserviceable PIN makes the earlier quote fail its check (`delivery` changed, then discarded), and the new route gets no quote.
- **Live couriers and production:**
  - a live courier that refuses, fails, or offers a price while saying the PIN isn't served gets no quote
  - production with no courier can't quote, and that maps to "Delivery isn't available yet"
- **Rates failures and quote refusals:** rates that couldn't load are an outage, not a refusal. A quote refusal overrides an earlier rates answer, and stock is not a delivery issue.
- **Quote despite an issue:** a quote that arrives while delivery is blocked (rates failed, the quote call a moment later didn't) still can't go on.
- **The page:** the issue replaces the options, no summary means no total unless checkout can go on, Try again calls the API again, and the order button stays disabled.

Command: `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/support/register.mjs --test tests/security/checkout/delivery-failure.test.mjs` after `npm run build:api`. Result: 10 of 10.

**Mutation checks** (each undone afterwards):

| Mutation | Tests failing |
|---|---|
| API quotes an unserviceable route | 6 |
| Rates kept when the courier says not serviceable | 2 |
| Outage not recognised | 1 |
| Unserviceable PIN not shown | 2 |
| Restricted item not shown | 1 |
| Checkout goes on despite an issue | 0 at first, 1 once the quote-despite-an-issue test was added |
| Total shown while delivery is blocked | 1 |
| Retry does nothing | 1 |

The first run had 9 tests and the "checkout goes on despite an issue" mutation survived: every failure case also had no quote. The test for a quote arriving while delivery is blocked was then added; the rerun failed 1 of 10, and the restored run passes 10 of 10.

**Wider runs:**

| Check | Result |
|---|---|
| `npm run test:security` | 413 of 413 |
| `npm run test:db` | 61 of 61 |
| `npm test` | 95 of 95 |
| `npm run typecheck` | clean |
| `npm run lint` | 0 errors, the 2 existing warnings |
| `npm run build` | passes |
| `npm run test:e2e` | 65 of 65 |

**Browser check** (dev server, port 5601, synthetic dev bag; screenshot `stage-12-12-unserviceable-pin.jpg`):

- **PIN 110999:** "We don't deliver to 110999 yet" with Change address and Contact us, the summary with no total, and the order button disabled. Change address opened the form.
- **PIN 110998:** the outage card, no total, `data-can-proceed="no"`. Try again made one new quote call and correctly still showed the outage, because the sandbox's 998 outage is permanent.
- **Afterwards:** the bag's address was set back to 560034.

**Not decided here (owner):** the wording of these messages. The restricted-item message doesn't name the item, because the API doesn't say which item is restricted; naming it would need an API addition.

## 12.13 Checkout quote integration gate (CHV-S12-M13), 27 October 2026

**Status:** PASS. Price, address, delivery and tax edge cases were run together, end to end through the production web host. Every case either got the correct quote or was blocked with an explanation, and payment stays disabled.

**Changed**

- `tests/e2e/checkout-gate.test.mjs` (new): the Stage 12 gate. It runs real HTTP against the production build, with one `next start` as development and one as production, and the API in-process on a throwaway database. Each visitor has its own address.
- **Independent expected totals:** the test works out every expected total itself from the owner's rules: per line, nearest paisa, half up; CGST and SGST each at half the rate; the discount and delivery fee shared by value with largest remainders; the sandbox's zone and slab prices. It does not reuse the server's code.
- No application code change.

**Checked**

- **Correct quotes:**

  | Case | Result |
  |---|---|
  | Within Karnataka | CGST and SGST on goods and fee, cheapest delivery |
  | To Maharashtra | 2 units, 10% code, air picked: IGST, discount and fee shared |
  | Mixed bag | 5% and 12% lines plus an odd price (₹999.99 × 3) with a code: the fee's GST split by value; the line discounts add up to the total discount |
  | Replaced state code | IN-OR is stored as IN-OD and priced as inter-state, national zone |
  | Perfume | surface only |
  | Signed-in customer | the same quote, with the account email |
  | Tampered request | prices, totals and fees in the body change nothing |

  For each, the totals, every line's GST, the fee's GST and the shown total match the independent expected values.
- **Blocked, with an explanation:**
  - **Address:** a malformed PIN, an unknown state, a landline instead of a mobile, or no address.
  - **Delivery:** an unserviceable PIN, a courier outage, a restricted item, an item with no weight, or a parcel over every courier's limit (25 kg). Each gives its issue and an action.
  - **Price and stock:** a stale bag, a price change after quoting (the quote fails its check, naming the price), stock taken after adding, or an item withdrawn.
  - **Tax:** a category with no rate in the profile, or production without an approved profile.
  - **Expiry:** an expired quote is refused, and a new one can be asked for.
- **Payment disabled:**
  - The API has no payment, webhook, checkout or confirm path. Its only quote paths are the preview and the check.
  - Orders can only be read; the one write is the existing Stage 07 claim of a guest order into an account, which creates no order.
  - The payment, checkout, confirm, orders and Razorpay webhook paths answer 401, 404 or 405 on both web hosts.
  - No order, payment attempt, reservation, provider event or shipment exists after the whole run.
  - The review's final button is disabled ("Payment opens soon"); production has no review page and keeps the bag's disabled "Checkout opens soon".
  - No page loads a payment provider.

**Test mistakes found by the first run and fixed** (the code was right each time):

- PIN 751001 is in the national zone, not regional.
- A signed-in customer must not send a different email, and the server rightly refused one.
- "080 2222 3333" reads as a valid mobile once the trunk 0 is dropped, so a Mumbai landline is used instead.
- The order-write check now names the claim route.

**Commands and results (Stage 12 gate run)**

- `npm run build:api`, then `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/support/register.mjs --test tests/e2e/checkout-gate.test.mjs`: 14 of 14 pass (CHV-S12-M13). Log: `stage-12-13-checkout-gate.log`.

| Check | Result |
|---|---|
| Stage 12 suites together (`tests/security/checkout/*`, `tests/security/tax/*`, `tests/security/shipping/*`) | 127 of 127 |
| `npm run test:security` | 413 of 413 |
| `npm run test:db` | 61 of 61 |
| `npm test` | 95 of 95 |
| `npm run typecheck` | clean |
| `npm run lint` | 0 errors, the 2 existing warnings |
| `npm run build` | passes |
| `npm run test:e2e` | 79 of 79 |

**Mutation checks** (each undone; restored 14 of 14):

| Mutation | Gate tests failing |
|---|---|
| GST rounded down instead of half up | 2 |
| No GST on the delivery fee | 6 |
| Every delivery taxed as inter-state | 4 |
| Whole discount put on the first line | 1 |
| Unserviceable route quoted | 1 |

## Stage 12 gate summary

All thirteen micro-stages pass (CHV-S12-M01 to M13).

- **Addresses and contact:** the shop takes Indian delivery addresses, validates PINs and states, keeps a saved address book for customers, and lets guests give contact details without an account.
- **Tax:** it has an owner-approved tax profile process and works out GST on the server, including on the delivery fee.
- **Delivery:** it checks courier answers, prices delivery with a test courier outside production, and clearly labels test rates.
- **Quote:** it prices the whole bag on the server, binds each quote to its owner and inputs, and expires it after 15 minutes.
- **Review page:** development and staging show the address, delivery options and the API's itemised total, and explain any delivery failure.

Payment stays disabled and production checkout stays closed. Awaiting the owner's acceptance of the Stage 12 gate.

**Owner decisions recorded during Stage 12 (26 and 27 October 2026):**

- **Addresses:** Indian mobile only, district required, 100 and 200 character limits.
- **Address book:** 20 addresses, a verified email required, and deleting the default promotes the newest.
- **Contact:** the delivery phone only; marketing sign-up not offered until its wording is approved.
- **Tax profile:** a GSTIN is required (the business will be GST registered).
- **Tax calculation:** per line, nearest paisa, half up; CGST and SGST each at half the rate; the bag discount shared by line value.
- **GST on the delivery fee:** shared by value and taxed at each line's rate.
- **Delivery choice:** the shopper picks, and the cheapest is the default.
- **Review page:** development and staging only.

**Still for the owner (and tax advisor):**

- real GST values, plus the advisor's sign-off on the worked examples and on delivery-fee GST
- courier set-up: pickup address and PIN, packaging and its allowance, cash on delivery, the courier account, and splitting oversize parcels
- product weights for every item
- the delivery fee rule (no markup or free-delivery threshold today) and the conflicting "Free shipping across India" header copy
- the wording of the review and failure messages
- carried from Stage 11: shopping as a guest with an unverified email, the line limits, and the cart lifetimes

## After the gate: testing pass and local database port (27 October 2026)

Asked by the owner after the Stage 12 commit: unit testing, integration testing and test-driven development. Log: `post-gate-testing.log`.

**Local database moved to port 15432**

- **The problem:** Windows reserved the port range 54248 to 54347 for its network service (WinNAT), which covers the old port 54329, so the database container could not start. The owner chose to move the port rather than restart WinNAT.
- **The fix:** 15432 is below Windows' dynamic port range (49152 and up), where those reservations happen. Changed in `compose.yaml`, the local defaults (`apps/api/prisma.config.ts`, `apps/api/src/db/client.ts`), the test helpers (`tests/integration/database/helpers.mjs`, `rehearsal.test.mjs`, `tests/ops/env.test.mjs`), `.env.example`, `README.md`, `apps/api/prisma/README.md`, `docs/ENVIRONMENT.md` and `docs/operations/environments.md`.
- **History notes:** `docs/DECISIONS.md` and `docs/operations/bootstrap.md` say why the port moved. Earlier evidence logs keep 54329, because they record what happened at the time.
- **Data:** the container was recreated, and its data volume (dev catalogue, migrations) kept. `.env.local` did not mention the port and was not touched.

**Coverage**

- Node's built-in coverage (`--experimental-test-coverage` with source maps) ran over the Stage 12 tests.
- Before: 92.3% of lines, 90.6% of branches, 95.4% of functions.
- Leaving out file header comments, the untested code was: editing a draft tax profile, listing profiles (and its route), the "ready for sale" path, a stored quote that fails its check because of tax, and three delivery wordings in the bag.

**Gap tests**

- `tests/security/tax/profile.test.mjs`:
  - editing a draft replaces its rates and is audited; an invalid edit changes nothing; only the owner edits
  - only the owner lists profiles, never cached, with the active profile first and then the newest
  - `assertTaxReadyForSale` returns once sales are ready
- `tests/security/checkout/quote-validity.test.mjs`: a quote whose category lost its tax rate is refused with `tax` named.
- `tests/security/shipping/sandbox-courier.test.mjs`: every delivery wording, and only a live deliverable answer says "Delivers to".

These passed on the first run, so the code was already right; mutations confirm they now guard it.

**Test-driven change: the restricted item is named** (follow-up noted in 12.12)

- **Red:** three tests were written first:
  - the rate check reports which restrictions no offer carries
  - the bag's rates name those items by title (a ring is named; the kurta and perfume in the same bag are not)
  - the message reads "We can't send Fixture ring to 110001", lists two or three items in plain English, and stays general when none is known

  All three failed against the unchanged code (log section "Red"), and every existing test passed.
- **Green:**
  - **Contract**, additive: `RateQuoteV1` unavailable gains `notCarried?` (only for `category_restricted` worked out by the server; a courier's own refusal names nothing, and nothing is guessed), and `ShippingRatesV1` gains `restrictedItems` (empty unless items are blocked).
  - **Code:** `apps/api/src/shipping/rates.ts` (`notCarriedBy`), `apps/api/src/shipping/courier.ts` (items in bag order, once each), `apps/api/src/modules/shipping.controller.ts` (OpenAPI), `lib/checkout.ts` (wording).
  - **Two existing tests** that compare the exact answer shape were updated for the new fields.
- **Mutations** (each undone afterwards):

  | Mutation | Tests failing |
  |---|---|
  | Every restriction blamed | 2 |
  | Every restricted item named | 1 |
  | Item not named in the message | 2 |
  | Draft edit keeps old rates | 1 |
  | Tax refusal not named | 1 |
  | A delivery promise without a deliverable answer | 1 |
  | Active profile not listed first | 0 at first, because the active profile was also the newest; 1 after the test added a newer draft |

  The restored run passes 68 of 68.

**Results**

| Check | Result |
|---|---|
| `npm test` (unit) | 95 of 95 |
| `npm run test:db` (integration, database) | 61 of 61 |
| `npm run test:security` (integration, API with database) | 420 of 420 |
| `npm run test:e2e` | 79 of 79 |
| `npm run build` | passes (the first run stopped at the Next.js notice, the retry passed) |
| `npm run typecheck` | clean |
| `npm run lint` | 0 errors, the 2 existing warnings |

- **Stage 12 coverage now:** 93.4% of lines, 91.7% of branches, 97.0% of functions.
- **Still not run by these tests** (header comments aside): one defensive fallback in `quote.ts` (line 244) and the environment switch in `lib/checkout.ts`, which the end-to-end tests cover.
- **Not checked in the browser:** the new named message is checked by tests, not visually.
- **Not committed.**
