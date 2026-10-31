# Stage 14 evidence: Razorpay payments and refunds

Started 31 October 2026. The owner accepted the Stage 13 gate by having it committed and pushed (0300956), followed by the Next.js 16.4.3 security patch (4831e8b) on the `upgrade` branch only. The branch is never merged into main.

**Testing rule (owner, 27 October 2026):** each micro-stage runs its own focused test (the CHV-S14-Mxx check); the wider suites run once at the Stage 14 gate.

**Sandbox only:** Razorpay stays in test mode until the merchant KYC, banking and tax approvals are confirmed. No raw card data ever reaches our servers (hosted checkout only).

## 14.01 Define the payment adapter contract (CHV-S14-M01), 31 October 2026

**Status:** PASS (focused test; wider suites at the Stage 14 gate). The payment module talks to every payment provider through one provider-neutral contract. Two very different providers fit it unchanged, and the payment code names no provider.

**Before this step:** `packages/contracts/src/integrations/payment-gateway.ts` (Stage 02) was an unused interface with Razorpay-shaped parts:
- the checkout return was a `signature` field;
- the checkout's input was a `receipt`;
- the session assumed an embedded checkout (`publicParams` only);
- there was no capture-status lookup and no error vocabulary.

**What changed**

- **Contract** `packages/contracts/src/integrations/payment-gateway.ts`, the `PaymentAdapter` interface:
  - `createCheckout`: takes the amount from the server, and the same idempotency key returns the same checkout. Its result tells the browser to continue either `embedded` (public parameters) or `redirect` (a URL).
  - `verifyReturn`: the browser's return comes in as a generic payload checked against our stored checkout reference. It is a hint only and never moves a payment.
  - `parseWebhook`: verifies the provider's signature over the raw body and normalizes the event to `ProviderPaymentEventV1`, or `null` for a verified event we don't act on.
  - `lookupPayment`, plus the new `captureStatus`: captured, not captured, failed or unknown.
  - `refund` and `lookupRefund`: the same key never refunds twice.
  - **Capabilities:** each adapter declares its checkout style, whether it captures separately, and whether it allows partial refunds, so the payment module adapts without knowing the provider.
  - **Neutral statuses:** each adapter maps its provider's own words; anything it cannot map is `unknown`, never a guess.
  - **`PaymentAdapterError` kinds:** `unavailable`, `timeout` and `invalid_response` mean the outcome is unknown (retry with the same key, record for reconciliation, never read as failed). `rejected`, `not_found` and `misconfigured` are definite.
  - **Compatibility:** `PaymentGateway` stays as an alias of `PaymentAdapter`, so earlier imports compile. Nothing used the old port.
- **Payment module** `packages/contracts/src/modules/payment.ts`: `PaymentSessionV1` now carries the neutral `next` step (embedded or redirect) instead of `publicParams` only. Its one user, `CheckoutConfirmationV1`, needs no change.
- **PhonePe kept open:**
  - `PaymentProviderName` and the database's `PaymentProvider` enum still list `phonepe`.
  - Only the launch list (`PAYMENT_PROVIDERS = ["razorpay"]`, owner decision, 30 October 2026) switches a provider on.
  - Adding PhonePe later means writing its adapter and adding it to that list; the payment module does not change.
- No API, database or storefront change; no provider SDK or key added.

**Test:** `tests/contracts/payment-adapter.test.mjs`, 17 tests (log `evidence/chaanavya/stage-14/stage-14-01-payment-adapter.log`), with two in-memory providers in `tests/contracts/fixtures/payment-adapters.ts`:
- an embedded, authorize-then-capture provider with lower-case statuses (Razorpay-shaped);
- a redirect, capture-at-once provider with upper-case states and its own transaction reference (PhonePe-shaped).

Neither uses a network or a real key. Both are declared `satisfies PaymentAdapter`, so `npm run typecheck` fails if either stops fitting the contract.

- **The same seven checks run against both providers:**
  - every method present, with declared capabilities;
  - the checkout carries the server's amount in paise, the same key gives the same checkout, the browser gets a neutral next step, and no secret reaches it;
  - forged returns are refused and checking a return changes nothing;
  - capture status is in neutral words, and a provider state the adapter cannot map is `unknown`;
  - verified webhooks take one shape, which the existing duplicate and conflict rule handles unchanged, scoped by provider; forged or unsigned bodies are refused, and events we don't act on are `null`;
  - the same refund key refunds once, and over-refunding is a definite `rejected`;
  - a timeout is outcome-unknown and retryable, while a misconfiguration is neither.
- **The payment code names no provider (CHV-S14-M01):** comments aside, the payment contracts and every API module that moves or acts on a payment contain no provider name, key prefix, provider header or provider field name:
  - `payment.ts`, `payment-gateway.ts`
  - `capture.ts`, `cancel.ts`, `recovery.ts` and `orders/admin.ts`
  - `db/transitions.ts`, `inventory/reservations.ts`
- **No provider-shaped fields or card data:** the contract has no `signature`, `receipt`, `notes` or provider-shaped fields, and no card number, CVV, expiry or PAN field.
- **Registries:** providers are named only in the registries; PhonePe stays valid in the contract and the database.

Command: `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test tests/contracts/payment-adapter.test.mjs`. Result: 17 of 17. Also run: `npm run typecheck` clean (the fixtures check against the contract); `npm run build:api` clean; `npm run lint` 0 errors, the 2 existing warnings; `npm test` 112 of 112 (95 before, plus these 17).

**Owner decisions (confirmed 31 October 2026):**

- **Return check:** a browser return never confirms a payment on its own; only a verified webhook or a server lookup moves money state. The buyer sees a short "confirming your payment" step.
- **Unknown outcome:** a provider timeout or unreadable answer is recorded as unknown, the stock stays held, and reconciliation asks the provider again; it is never treated as a failed payment.

## 14.02 Validate sandbox configuration boundaries (CHV-S14-M02), 31 October 2026

**Status:** PASS (focused test; wider suites at the Stage 14 gate). The payment keys are read on the server only. Sandbox credentials cannot reach the live gateway: test and live never mix, either when the keys load or at any later call. Live payments stay refused everywhere until the legal gate is opened.

**Before this step:** the Stage 03 start-up check matched the payment mode to the environment and scanned for the other mode's key prefix. Nothing in the API loaded the keys or guarded a call, and production expected live keys with no legal gate.

**What changed**

- **Legal gate** `packages/shared/src/config/payments-gate.ts` (new):
  - `LIVE_PAYMENTS_GATE` is frozen and closed today. Live payments need merchant KYC, banking and tax all confirmed, plus who approved it and the date.
  - Opening it is a reviewed code change made on the owner's written approval, never a server setting.
- **Start-up check** `packages/shared/src/config/env.ts`: `PAYMENT_MODE=live` or an `rzp_live_` key is refused with the legal-gate message while the gate is closed, so the API and worker do not start that way outside development. `checkEnv` takes an optional `liveGate` for tests only.
- **Server-side loader** `apps/api/src/integrations/razorpay/config.ts` (new), `loadRazorpayConfig`:
  - **No key:** payments are off, which is not an error.
  - **Refused (mode):** a missing or unknown `PAYMENT_MODE`; live while the gate is closed; sandbox in production; live in development or staging; a key whose prefix doesn't match the mode.
  - **Refused (mixing):** any other setting holding the other mode's key.
  - **Refused (secrets):** a missing key secret or webhook secret, a key ID in the secret's place, or a webhook secret equal to the key secret.
  - Each refusal is a `PaymentConfigError` that names the setting, never its value.
- **The configuration object** `RazorpayConfig`:
  - Frozen; the secrets are private fields, so JSON, `inspect` and logs show only the provider, mode and key ID.
  - Its constructor checks the boundary itself, so a mixed or ungated configuration cannot be built by hand either.
- **The client** `razorpayClient`:
  - The only way to call Razorpay. Every request re-checks the boundary: the key's prefix matches the mode, and live needs the open gate.
  - It accepts only a Razorpay API path (`/v1/...`) and sends to the Razorpay API host only.
  - If any check fails, nothing is sent.
- **Test updated** `tests/ops/env.test.mjs` (Stage 03): its production fixture uses live keys, which are now refused while the gate is closed. The test checks both: refused without the approval, accepted with a recorded approval.
- Not yet wired into a route or job; the Razorpay adapter (14.03 onward) builds on this loader and client.

**Test:** `tests/security/payments/sandbox-config.test.mjs`, 14 tests, all keys fake (log `stage-14-02-sandbox-config.log`, run together with `tests/ops/env.test.mjs`: 34 of 34):

- **Loading:**
  - With no key, payments are off.
  - A sandbox configuration loads in development and staging, and its secrets never appear in JSON, `inspect`, strings or keys.
  - Every mix is refused, naming the setting and never a value:
    - a live key in test mode, or a test key in live mode;
    - the other mode's key in a spare setting;
    - a key ID as the secret;
    - a missing mode or secret;
    - an equal webhook secret.
  - Sandbox is refused in production, and live in development and staging even with an open gate.
- **Legal gate:**
  - It is closed and frozen today.
  - Live keys in production are refused while any of the five parts is missing (KYC, banking, tax, approver, a real date). With the full approval they load, which shows the gate is what blocks live.
  - The start-up check refuses `PAYMENT_MODE` and `RAZORPAY_KEY_ID` with the gate message and leaks no secret.
- **Client (CHV-S14-M02):**
  - A sandbox client sends its own test key to the Razorpay API host only.
  - Six forged paths (another host, protocol-relative, `..`, `/v2`, a query string, no leading slash) are refused with nothing sent.
  - A loaded configuration cannot be switched to live or given another key.
  - A mixed or ungated configuration cannot be constructed.
  - An object posing as a configuration with a live key is refused at the call, and nothing is sent.
- **Web host:** no storefront or admin UI code reads a payment secret or imports the Razorpay integration. The start-up check refuses payment secrets on the web host and as `NEXT_PUBLIC_` settings.

Command: `npm run build:api`, then `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/support/register.mjs --test tests/security/payments/sandbox-config.test.mjs tests/ops/env.test.mjs`. Result: 34 of 34 (14 new, 20 Stage 03). `npm run typecheck` clean; `npm run lint` 0 errors, the 2 existing warnings.

**Mutation checks** (each applied, tested, then restored; the restored code passes 34 of 34; log `stage-14-02-mutations.log`):

| Mutation | Tests failing |
|---|---|
| Loader accepts a key from the other mode | 1 of 34 |
| Loader ignores the other mode's key in spare settings | 1 of 34 |
| Client boundary skips the legal gate | 1 of 34 |
| Client boundary skips the key-prefix check | 1 of 34 |
| Client lets a path leave the Razorpay host | 1 of 34 |
| Configuration object is not frozen | 1 of 34 |
| Start-up check ignores the gate for `PAYMENT_MODE` | 2 of 34 |
| Gate ignores the approval date | 1 of 34 |

**Defaults set here (owner to confirm):**

- **Production:** takes no payments at all until the legal gate is opened; sandbox keys are never allowed there.
- **What opens the gate:** merchant KYC, banking and tax all confirmed, with the approver's name and the date recorded, through a reviewed code change, not a server setting.
- **Payments off by default:** with no payment key configured, payments are simply off, in every environment.

## 14.03 Define payment attempt persistence (CHV-S14-M03), 31 October 2026

**Status:** PASS (focused test; wider suites at the Stage 14 gate). One logical payment attempt has one stable identity. Opening it again, with the same key, another key or many requests at once, gives the same attempt. Its identity and the provider's references cannot be rewritten, by the service or directly in the database.

**Before this step:** the `payment_attempt` table (Stage 04) already had the needed columns (amount, currency, order, provider and mode, the provider's references, state, a unique idempotency key) and a payment state machine (13.07). Gaps:
- Nothing opened or reused attempts.
- An order could have several attempts in progress at once.
- An attempt could ask for any amount.
- Its order, amount, key or provider references could be rewritten, and attempts could be deleted.

**What changed**

- **Migration** `20261031000000_payment_attempt_identity` (rollback in `prisma/rollback/`):
  - **One in progress:** a partial unique index allows one attempt in progress per order (created, authorized or waiting for its outcome). Ended attempts (captured, failed, expired, refunded) do not count.
  - **Exact amount:** an insert trigger requires the attempt to ask for exactly its order's grand total in the order's currency. A CHECK limits the currency to INR and requires a non-blank key.
  - **Fixed identity:** an update trigger refuses any change to the order, provider, mode, amount, currency, key or creation time, and refuses to replace or clear a provider order or payment reference once written. State still moves only through the 13.07 machine.
  - **Kept:** a delete trigger keeps every attempt.
- **Service** `apps/api/src/payments/attempts.ts` (new):
  - `openAttempt` locks the order (`FOR NO KEY UPDATE`), then:
    - returns the attempt for the same key, or the one already in progress;
    - otherwise creates one for the order's own total and currency, read on the server.
  - It refuses (nothing written): a malformed key (400), a provider not on the launch list (409), an order not waiting for payment (409), an ended payment window (409), an unknown order (404).
  - **Scoped keys:** keys are stored as `order:<orderId>:<key>`, so one order's key never finds another order's attempt.
  - **Races:** a simultaneous open that loses the race returns the winner's attempt.
  - `recordProviderOrderRef` writes the provider's checkout reference once. The same value again is a no-op; a different one is refused (409).
- **Older fixtures updated to the new rules** (no application change):
  - `cancel.test.mjs` and `events.test.mjs` create attempts for the order's real total instead of ₹0.01.
  - `payment-fulfilment.test.mjs` uses one order per attempt in its every-pair database check.
  - `late-capture.test.mjs` creates the second payment's attempt after the first is captured. The second-payment exception is still tested; two attempts in progress at once can no longer exist.
- **14.01 scan widened:** the provider-name scan in `tests/contracts/payment-adapter.test.mjs` now also covers `apps/api/src/payments/attempts.ts`.

**Test:** `tests/security/payments/attempts.test.mjs`, 10 tests, orders placed through the web host's forwarder (log `stage-14-03-attempts.log`):

- **Records:** the order's own total in INR, the order, provider, mode, state and order-scoped key; provider references empty until known.
- **Stable identity (CHV-S14-M03):**
  - The same key, another key and a second tab get the same attempt.
  - Twelve simultaneous opens with mixed keys create one attempt; exactly one caller created it, and all twelve got it.
  - The same key on another order is a different attempt.
  - After an attempt ends, a new one gets its own identity; the first key still finds the first, ended attempt and never repoints.
- **Refusals, writing nothing:** three bad keys; PhonePe (not switched on) and an unknown provider; an ended window; an unknown order; a cancelled order.
- **Provider reference:** written once; the same again is a no-op; a different one is 409; an unknown attempt is 404.
- **Database, whoever writes:**
  - Seven identity fields cannot change, and the attempt cannot be deleted.
  - Provider references cannot be replaced or cleared, while a valid state move still works.
  - Inserts with a wrong amount, a non-INR currency or a blank key are refused.
  - A second attempt in progress is refused in each of its three states, and a failed attempt may sit beside the one in progress.

Command: `npm run build:api`, then `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/support/register.mjs --test tests/security/payments/attempts.test.mjs`. Result: 10 of 10.

**Also run, because the new database rules apply to every writer:**
- `tests/security/orders/*.test.mjs` with `tests/security/payments/*.test.mjs`: 184 of 185 at first. The failure was the 13.11 second-payment test above, fixed by ordering; it then passed 6 of 6.
- `tests/integration/database/inventory.test.mjs` with `tests/contracts/payment-adapter.test.mjs`: 28 of 28.
- `npm run test:db`: 61 of 61, with no schema drift.
- `npm run typecheck` clean; `npm run lint` 0 errors, the 2 existing warnings.

**Mutation checks** (each applied, tested, then restored; the restored code passes 10 of 10; log `stage-14-03-mutations.log`):

| Mutation | Tests failing |
|---|---|
| No one-open-attempt-per-order index | 1 of 10 |
| Insert does not check the order's total | 1 of 10 |
| Amount may change after creation | 1 of 10 |
| Provider order reference may be replaced | 1 of 10 |
| Attempts may be deleted | 1 of 10 |
| Service ignores an attempt already in progress | 0 of 10: the one-open index refuses the second insert and the service returns the attempt in progress, so behaviour stays correct (the database is a working second safeguard) |
| Service key not scoped to the order | 2 of 10 |
| Service takes any provider | 1 of 10 (removing the check outright fails to compile) |
| Service skips the payment-window check | 1 of 10 |
| Service replaces a provider reference | 1 of 10 |

**Defaults set here (owner to confirm at the Stage 14 gate):**

- **Reuse:** a second checkout tab, or a new key while an attempt is in progress, returns the attempt in progress rather than starting another payment.
- **New attempt:** a new attempt can start only after the previous one has ended (failed, expired or captured).
- **Kept forever:** attempts are never deleted.

## 14.04 Create a Razorpay sandbox order (CHV-S14-M04), 31 October 2026

**Status:** PASS (focused test; wider suites at the Stage 14 gate). A shopper's pending order can open a Razorpay sandbox checkout for exactly the saved order's grand total in INR paise. The browser cannot change that amount: the route never reads the request body. One attempt gets one Razorpay order, however often it is asked.

**What changed**

- **Razorpay adapter** `apps/api/src/integrations/razorpay/adapter.ts` (new). Only `createCheckout` works so far; the other contract operations answer "not available yet (a later Stage 14 step)".
  - **The call:** `POST /v1/orders` for the given amount in INR, with the order number as the receipt and the attempt id in the notes, through the 14.02 client (sandbox only, Razorpay host only, 10-second timeout).
  - **Refused before calling:** an amount below ₹1, a non-whole amount, or a non-INR currency.
  - **The answer is checked:** it must be a Razorpay order (`order_...`), status `created`, for exactly the amount in INR. Anything else is an invalid response and nothing is recorded.
  - **Errors:** an unreachable provider is `unavailable`, a timeout is `timeout`, a refused key is `misconfigured`, and other 4xx answers are `rejected`.
  - **Session:** the browser gets public values only: the key ID, the Razorpay order id, the amount, the currency, the shop name and the order number.
- **Contract** `packages/contracts/src/integrations/payment-gateway.ts`: `CreateCheckoutInput` gains an optional, provider-neutral `existingProviderOrderId`, so an adapter rebuilds a checkout it already opened instead of opening another. The 14.01 fakes are unaffected.
- **Adapter choice** `apps/api/src/integrations/payments.ts` (new): `paymentAdapterFor(env)` returns the Razorpay adapter when a sandbox key is configured, `null` when payments are off. This is the only place a provider is named; the payment module never names one.
- **Service** `apps/api/src/payments/start.ts` (new), `startPayment`:
  - Only the shopper's own order placed from a quote; another shopper's order is the same 404 as an unknown one.
  - Opens or reuses the 14.03 attempt.
  - Refuses with 409 when a payment is already under way (checked before and again under the lock).
  - Locks the attempt row while asking the provider, so simultaneous requests open one Razorpay order.
  - Rebuilds the session from the stored reference on any retry.
  - Records the reference once (14.03).
  - The amount sent is the attempt's, which is the order's own total.
  - Errors: a provider that cannot be reached or answers wrongly is 502 with nothing recorded (retry with the same key); a refused key is 503.
- **Route:** `POST /api/v1/cart/order/{orderId}/payment` in `order-intent.controller.ts`:
  - Shopper session, `Idempotency-Key` required, rate limited, `no-store`.
  - It never reads the body.
  - 404 in production (with order placement); 503 when payments are off.
  - Returns `{ data: { attemptId, provider, providerOrderId, amount, next }, reused }`.
- **Errors:** `ApiErrorCode` gains `unavailable` for a dependency that cannot act now.
- **Schemas and gate:**
  - OpenAPI regenerated, 76 paths (was 75).
  - The Stage 12 checkout-gate test now allows this one payment path and lists it among the order writes, with the reason. No webhook, capture or confirm path exists yet.

**Test:** `tests/security/payments/start.test.mjs`, 10 tests (log `stage-14-04-start-payment.log`). Orders are placed through the web host's forwarder; Razorpay is a recording stand-in on the network (requests to its host are answered by the test, everything else passes through); all keys are fake.

- **The amount:**
  - One sandbox order is created for exactly the order's total in INR, with the order number as receipt and the sandbox key.
  - The browser gets public values only; no secret appears.
  - The attempt records the reference and amount.
- **Browser cannot override (CHV-S14-M04):** five forged requests (amounts and currencies in the body, a forged provider order id and attempt id, query parameters, headers) each produced a provider request for the saved total in INR, and a response showing the saved total.
- **Once:**
  - A retry, another tab, and five more simultaneous requests get the same attempt and checkout from one provider call.
  - Five simultaneous first requests for a fresh order also ask the provider once.
- **Distrust:**
  - A Razorpay order for another amount, or one not new, is not believed: 502, nothing recorded, and a retry asks again.
  - An unreachable provider is 502 and a refused key 503, with nothing recorded.
- **Access:**
  - Another shopper's order, a visitor, an unknown id and a malformed id are all 404; a missing key is 428 and a bad key 400. The provider is never asked.
  - A cancelled order is 409, and a payment already under way is 409, with no new provider order.
  - With payments off: 503 and no attempt. In production the route does not exist.
  - The adapter itself refuses amounts below ₹1, fractional paise and non-INR, without asking.
- **Not covered here:** an ended payment window, because an order's deadline is part of its purchase snapshot and the database refuses to move it. `tests/security/payments/attempts.test.mjs` covers the window refusal at the service level.

Command: `npm run build:api`, then `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/support/register.mjs --test tests/security/payments/start.test.mjs`. Result: 10 of 10.

**Also run:**
- `tests/security/payments/*.test.mjs` with `tests/security/api/routes.test.mjs`, `tests/contracts/payment-adapter.test.mjs` and `tests/ops/env.test.mjs`: 70 of 70.
- `npm run api:openapi` 76 paths; `npm run typecheck` clean; `npm run lint` 0 errors, the 2 existing warnings.
- The checkout-gate e2e test runs at the Stage 14 gate.

**Mutation checks** (each applied, tested, then restored; the restored code passes 10 of 10; log `stage-14-04-mutations.log`). The first run showed the lock untested: the burst came after the first checkout existed. A simultaneous-first-request test was added, and the lock mutation is now caught.

| Mutation | Tests failing |
|---|---|
| Adapter asks the provider for a different amount | 6 of 10 |
| Adapter believes an order for another amount | 1 of 10 |
| Adapter believes an order that is not new | 1 of 10 |
| Adapter accepts amounts below one rupee | 1 of 10 |
| Service opens a new provider order on every retry | 2 of 10 |
| Service does not lock the attempt | 1 of 10 |
| Payment-under-way check removed before the lock only, or under the lock only | 0 of 10 each: the other copy still refuses (a double guard) |
| Both payment-under-way checks removed | 1 of 10 |
| Route open in production | 1 of 10 |
| Misconfigured provider reported as a retryable 502 | 1 of 10 |
| Another shopper's order allowed | 1 of 10 |

**Defaults set here (owner to confirm at the Stage 14 gate):**

- **Shop name:** Razorpay's checkout shows "Chaanavya" and "Order CHV-…" to the buyer.
- **Minimum amount:** ₹1 (Razorpay's own minimum).
- **Return address:** redirect checkouts come back to `/checkout/payment` on the web host. That page does not exist yet; Razorpay's embedded checkout does not use it.
- **Shopper's message when the provider fails:** "try again" (502), or "payments are not available right now" (503).

## 14.05 Gateway request retries and timeouts (CHV-S14-M05), 31 October 2026

**Status:** PASS (focused test; wider suites at the Stage 14 gate). A timeout never opens a second Razorpay order for one payment attempt, so a buyer can never be asked to pay twice. Calls are repeated only when repeating is safe, a bounded number of times, inside one time budget.

**What changed**

- **Adapter** `apps/api/src/integrations/razorpay/adapter.ts`, `RAZORPAY_RETRY` (3 tries per call, waits of 0.25 s then 0.75 s, a 15-second budget per checkout):
  - **Ask first:** before creating, the adapter looks up Razorpay's orders by receipt (the order number) and takes the one whose notes carry this attempt's id. An earlier request that opened the order and lost the answer (a timeout, a crash) is found here, so no second order is created.
  - **Create carefully:** creating an order is repeated only when Razorpay certainly did not act: the connection was refused before sending, or it answered 429. After a timeout or a 5xx the outcome is unknown, so the create is never repeated; the adapter asks Razorpay for the attempt's order instead and adopts it if it exists.
  - **Still unknown:** if that lookup cannot answer either, the shopper gets the 14.04 502 ("try again") with nothing recorded. Their retry looks up first and adopts the order opened earlier.
  - **Lookups** change nothing, so they are repeated after a timeout, a lost connection, 429 or 5xx.
  - **Distrust kept:** only an order for exactly the attempt's amount in INR is adopted. One that does not match was never believed, never reached a browser, and so cannot be paid.
  - **Time:** every call's timeout is cut to what is left of the budget, and no call starts with less than 0.25 s left. The budget ends before the 20-second payment lock in `start.ts`.
- **Client** `apps/api/src/integrations/razorpay/config.ts`: requests take query values (encoded by `URLSearchParams`; the path check is unchanged) and a shorter timeout, never a longer one than 10 seconds.
- **14.04 test** `tests/security/payments/start.test.mjs`: the stand-in now keeps the orders it opens and answers lookups as Razorpay does; its counts are of creates. All 10 still pass.

**Why there is no duplicate charge.** A Razorpay order can only be paid through a checkout carrying its id, and only the server hands that id out: one per attempt, under the 14.04 row lock, recorded once (14.03). An order whose answer was lost is either found and adopted, or never shown to anyone.

**Test:** `tests/security/payments/retries.test.mjs`, 12 tests (log `stage-14-05-gateway-retries.log`, with the 14.04 tests: 22 of 22). Razorpay is a scripted stand-in on the network; each call can open the order and lose the answer, time out, answer 5xx or 429, refuse the connection, or hang.

- **Timeout, no duplicate (CHV-S14-M05):**
  - Order opened, answer lost: the same request asks and adopts it; one create, one order.
  - Order opened, then 503: adopted the same way.
  - Order opened, answer and every lookup lost: 502, nothing recorded; two retries (same key, new key) adopt the order opened earlier; still one create and one order.
  - Timeout before Razorpay acted: 502, the create not repeated in that request; the retry opens exactly one order.
  - Five simultaneous first requests while the answer is lost: all get the same checkout; one create, one order.
- **Bounded and safe:**
  - A refused connection or 429 on create is repeated and still opens one order.
  - A lookup after a timeout or 503 is repeated.
  - A Razorpay that keeps failing is asked 3 times, then 502, with no create.
  - The budget is shorter than the payment lock.
- **Hung calls** (adapter level, 0.8 s budget):
  - A create that never answers is aborted within the budget, not repeated, and reported as an unknown outcome that may be retried.
  - A lookup that never answers uses up the budget, and no create is attempted without knowing.
  - An order Razorpay holds for the attempt at another amount is never adopted or shown.

Command: `npm run build:api`, then `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/support/register.mjs --test tests/security/payments/retries.test.mjs tests/security/payments/start.test.mjs`. Result: 22 of 22.

**Also run:**
- `tests/security/payments/*.test.mjs` with `tests/security/api/routes.test.mjs`, `tests/contracts/payment-adapter.test.mjs` and `tests/ops/env.test.mjs`: 83 of 83.
- `npm run typecheck` clean; `npm run lint` 0 errors, the 2 existing warnings.

**Mutation checks** (each applied, tested, then restored; log `stage-14-05-mutations.log`). One mutation, removing the lookup after an unknown create, did not compile. A second form that ignores the order the lookup finds was run instead and is caught.

| Mutation | Tests failing |
|---|---|
| No lookup before creating | 4 of 12 |
| Order found after an unknown create ignored | 3 of 12 |
| Create repeated after any failure (timeouts and 5xx too) | 5 of 12 |
| Create never repeated, even when Razorpay certainly did not act | 1 of 12 |
| Lookups never repeated | 3 of 12 |
| Unbounded tries | 2 of 12 |
| Timeout not cut to the budget | 1 of 12 |
| Adopts an order for another amount | 1 of 12 |
| A refused connection treated as possibly sent | 1 of 12 |
| A timeout counted as "Razorpay did not act" | 4 of 12 |
| Budget longer than the payment lock | 1 of 12 |
| Client ignores the shorter timeout | 1 of 12 |

**Not covered here:** Razorpay's real lookup filter is assumed to work as documented (orders filtered by `receipt`); the sandbox account is not called by any test. Webhooks, capture and refunds, the other places a retry could matter, arrive in later Stage 14 steps.

**Defaults set here (owner to confirm at the Stage 14 gate):**

- **Retry policy:** 3 tries per call, waits of 0.25 s and 0.75 s, a 15-second budget per checkout, 10 seconds at most per call. A shopper may wait up to about 15 seconds before seeing "try again".

## 14.06 Hosted checkout hand-off (CHV-S14-M06), 31 October 2026

**Status:** PASS (focused test; wider suites at the Stage 14 gate). A pending order can be handed to Razorpay's Standard Checkout, which collects every payment detail in Razorpay's own frame on Razorpay's host. No Chaanavya page has a payment field. Card details sent to us anyway are dropped and leave no trace.

**What changed**

- **Hand-off rules** `lib/payment-handoff.ts` (new, presentation only):
  - The script is `https://checkout.razorpay.com/v1/checkout.js` (Razorpay's approved Standard Checkout), named in this one file.
  - `razorpayCheckoutOptions(session)` passes Razorpay exactly six public values: the key ID, Razorpay's order id, the amount, the currency, the shop name and the order label. Anything else in the session is dropped.
  - It opens nothing unless the session agrees with itself (the same Razorpay order and amount, INR) and the key is a test key. Live keys wait for the 14.02 legal gate.
  - What the checkout reports back is a hint only; nothing on the page records a payment or changes an order.
- **Pay page** `app/(store)/checkout/pay/[orderId]/page.tsx` and `components/checkout/payment-handoff.tsx` (new). Development and staging only, like the review; 404 in production.
  - It shows the order and total from `GET /api/cart/order/{id}`.
  - "Pay ₹…" calls `POST /api/cart/order/{id}/payment` with no body, loads Razorpay's script and opens its window.
  - When the buyer finishes in the window, the page says Razorpay is confirming the payment and asks them not to pay again. The order changes only when the API hears from Razorpay (later steps).
  - Closing the window lets the buyer try again. A failed payment and a window that did not load each have their own message.
  - Errors: 502 lets the buyer retry; 503, 409 (payment under way, expired, ended) and 404 say what happened.
  - The page has no form or input.
- **Browser policy** `proxy.ts`: on the pay page only, and never in production, the CSP adds Razorpay's script host, a `frame-src` for its payment frame (`api.razorpay.com`, `checkout.razorpay.com`), the hosts that frame talks to, and its image host. `form-action 'self'` is unchanged everywhere. Every other page keeps the strict policy with no frames.
- **Pop-ups** `next.config.ts`: the pay page sends `Cross-Origin-Opener-Policy: same-origin-allow-popups`, because Razorpay opens net banking and card authentication in a pop-up that reports back to its window. Every other page, including any other path under `/checkout/pay/`, keeps `same-origin`.

**Not changed:** the review page's "Payment opens soon" button. No Stage 14 step names the "Place order" step that would lead a shopper from the review to the pay page, and the Stage 12 gate pins that button as disabled. The pay page is reached by its address after an order is placed. This is an owner question for the Stage 14 gate.

**Test:** `tests/e2e/payment-handoff.test.mjs`, 8 tests (log `stage-14-06-payment-handoff.log`). Real HTTP against `next start` as development and as production; the API in-process on a throwaway database; Razorpay's orders API is a recording stand-in; keys are fake; the card is Razorpay's published test card.

- **Pay page only:**
  - The pay page's policy names Razorpay's listed hosts and no others, has `frame-src` for Razorpay's frame only, keeps `form-action 'self'`, and allows pop-ups.
  - The home page, the review, a longer path and a malformed order id get no Razorpay host, no frames and `same-origin`.
  - In production the pay page is 404 and allows Razorpay nowhere.
- **Public values only:**
  - A session stuffed with a card number, CVV, a payment method and a callback address hands Razorpay the six public values and nothing else.
  - A live key, a mismatched order, amount or currency, another provider and a redirect session are all refused.
- **Card details never kept (CHV-S14-M06):** a shopper placed an order through the development web host, then asked for the checkout with a card number, CVV and expiry in the body, the query string and a header.
  - The checkout opened for the saved total.
  - The card number (plain and spaced) and expiry appear nowhere: not in the answer, not in the request to Razorpay, not in the API's or the web host's output, and in none of the database's tables (every row of every table searched).
- **No payment fields:**
  - No file in `app/`, `components/` or `lib/` has a card, CVV or expiry field.
  - The pay component has no form or input and sends the payment request without a body.
  - Only `lib/payment-handoff.ts` names Razorpay's checkout host.

Command: `npm run build:api`, `npm run build`, then `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/support/register.mjs --test tests/e2e/payment-handoff.test.mjs`. Result: 8 of 8.

**Also run:**
- `tests/e2e/checkout-review.test.mjs`, `tests/e2e/checkout-gate.test.mjs` and the 14.04 and 14.05 payment tests: 43 of 43.
- `npm run typecheck` clean; `npm run lint` 0 errors, the 2 existing warnings.

**Mutation checks** (each applied, rebuilt where it touches the web host, tested, then restored; the restored code passes 8 of 8; log `stage-14-06-mutations.log`). All 11 caught.

| Mutation | Tests failing |
|---|---|
| Razorpay allowed on every page | 2 of 8 |
| Razorpay allowed in production too | 1 of 8 |
| Pay page without its frame rule | 1 of 8 |
| Form posts allowed to Razorpay | 1 of 8 |
| Pay page keeps the same-origin opener (pop-ups cut off) | 1 of 8 |
| Every session value passed to Razorpay | 1 of 8 |
| Live keys accepted | 1 of 8 |
| Razorpay order not checked against the session | 1 of 8 |
| Amount not checked against the session | 1 of 8 |
| Pay path matches any segment | 1 of 8 |
| Pay button sends a body | 1 of 8 |

**Not covered here:** the pay page was not looked at in a browser (the browser pane serves the main folder only, which is not changed). Razorpay's real checkout window is not opened by any test: it needs a real sandbox key and a browser on Razorpay's site. The hosts allowed are the ones Razorpay publishes for Standard Checkout; if Razorpay adds a host, the window would show a policy error in the browser console, and the fix is one line in `lib/payment-handoff.ts`.

**Defaults set here (owner to confirm at the Stage 14 gate):**

- **Place order button:** whether the review page's "Payment opens soon" becomes "Place order and pay", and in which step (no micro-stage names it).
- **No prefill:** Razorpay's window asks the buyer for their phone and email itself. We could fill them from the order, which would send them to Razorpay from the browser.
- **Wording:** "Pay ₹…", the "confirming your payment" message, and "Your card, UPI and bank details go to Razorpay, not to us."

## 14.07 Checkout return ingestion (CHV-S14-M07), 31 October 2026

**Status:** PASS (focused test; wider suites at the Stage 14 gate). When the buyer finishes in Razorpay's window, the pay page sends what the window handed it to the API. The API reads it as an untrusted signal, checks its shape against the checkout it opened, records nothing, and answers with its own record of the order. The browser saying "paid" never marks an order paid.

**What changed**

- **Route** `POST /api/v1/cart/order/{orderId}/payment/return` in `order-intent.controller.ts`:
  - Shopper session, rate limited (20 a minute), `no-store`, body at most 2 KB.
  - 404 in production (with order placement); 503 when payments are off.
  - Returns `{ data: { orderId, orderStatus, paymentStatus, outcome } }`. `outcome` is `paid` only when our records hold the order as confirmed; `not_paid` when the payment failed or expired or the order was cancelled; otherwise `confirming`.
- **Service** `apps/api/src/payments/checkout-return.ts` (new), `receiveCheckoutReturn`:
  - Only the shopper's own order placed from a quote; another shopper's order is the same 404 as an unknown one.
  - The report must be a flat object of at most 8 short strings (400 otherwise).
  - It is checked against the order's latest attempt that opened a checkout (409 when none did).
  - Nothing is written. No call to Razorpay is made.
- **Razorpay adapter** `verifyReturn`: exactly Razorpay's three fields (`razorpay_payment_id`, `razorpay_order_id`, `razorpay_signature`), each in Razorpay's format, for the Razorpay order we stored. Anything else is refused. The signature is not checked until 14.08, so the answer is always "not verified".
- **Pay page** `components/checkout/payment-handoff.tsx`: when Razorpay's window finishes, the page sends only those three fields (`returnFields` in `lib/payment-handoff.ts`). It shows "confirming" unless the API answers `paid`.
- **Schemas and gate:**
  - OpenAPI regenerated, 77 paths (was 76).
  - The Stage 12 checkout-gate test now allows this path among the payment and order-write paths, with the reason.

**Test:** `tests/security/payments/checkout-return.test.mjs`, 8 tests (log `stage-14-07-checkout-return.log`). Orders are placed and checkouts opened through the web host's forwarder; Razorpay is a stand-in; payment ids and signatures are random fakes.

- **Browser success is not payment (CHV-S14-M07):**
  - A well-formed success report for the order's own checkout gets `confirming`, `pending_payment`, `created`.
  - The order, its payment attempt (no payment id, no captured amount), its stock hold (still `active`), its trail and the provider events are unchanged, and Razorpay is not called.
- **Replays and races:** the same report twice and six simultaneous reports with different payment ids all get `confirming` and change nothing.
- **Forged reports:** 14 kinds, all 400 with nothing changed:
  - extra claims (`status: captured`, `paid`, `amount`);
  - a missing field, or a payment id or signature not in Razorpay's format;
  - another Razorpay order;
  - objects, arrays, numbers, empty or over-long values, and an empty body.
  - A 4 KB body is 413.
- **Another order's checkout:** a report naming another shopper's Razorpay order is 400, both ways.
- **Our record decides:** a payment marked failed is answered `not_paid` whatever the browser says.
- **Access:** another shopper's order, a visitor, an unknown and a malformed id are all 404. An order with no checkout opened is 409. With payments off it is 503; in production the route does not exist.
- **Pay page:** only Razorpay's three fields are passed on; extra fields are dropped.

Command: `npm run build:api`, then `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/support/register.mjs --test tests/security/payments/checkout-return.test.mjs`. Result: 8 of 8.

**Also run:**
- After `npm run build`: all `tests/security/payments/*.test.mjs`, `tests/security/api/routes.test.mjs`, `tests/contracts/payment-adapter.test.mjs`, `tests/ops/env.test.mjs`, `tests/e2e/payment-handoff.test.mjs`, `tests/e2e/checkout-gate.test.mjs` and `tests/e2e/checkout-review.test.mjs`: 120 of 120.
- `npm run api:openapi` 77 paths; `npm run typecheck` clean; `npm run lint` 0 errors, the 2 existing warnings.

**Mutation checks** (each applied, tested, then restored; the restored code passes 8 of 8; log `stage-14-07-mutations.log`). 11 caught; the 12th did not compile.

| Mutation | Tests failing |
|---|---|
| The browser's success believed (`paid` for a valid report) | 3 of 8 |
| Extra fields accepted | 1 of 8 |
| A report for another Razorpay order accepted | 2 of 8 |
| Signature format not checked | 1 of 8 |
| Payment id format not checked | 1 of 8 |
| Shape check removed | 1 of 8 |
| Another shopper's order allowed | 1 of 8 |
| Route open in production | 1 of 8 |
| No-checkout check removed | refused by the compiler |
| A failed payment still answered `confirming` | 1 of 8 |
| Report size limit lifted | 1 of 8 |
| Pay page passes on every field Razorpay hands it | 2 of 8 |

**Not covered here:**
- The `paid` answer is not reached by a test: no step can confirm an order yet (that needs a verified capture, 14.11 and 14.12).
- The pay page's sending of the report was not tried in a browser against Razorpay's real window.

**Defaults set here (owner to confirm at the Stage 14 gate):**

- **Nothing kept:** the browser's report is not stored. A reconciliation job can find the payment from Razorpay by its order, without the browser's word (14.14).
- **Wording:** "Payment received. Thank you, your order is confirmed." shown only when our records say so.

## 14.08 Checkout signature validation (CHV-S14-M08), 31 October 2026

**Status:** PASS (focused test; wider suites at the Stage 14 gate). The checkout return from 14.07 is now checked against Razorpay's signature. The signature is computed on the server over the Razorpay order we stored and the payment id the browser sent. A tampered payment id or signature is a 400. A verified return still marks nothing paid.

**What changed**

- **Signature check** `apps/api/src/integrations/razorpay/config.ts`, `RazorpayConfig.checkoutSignatureMatches(orderId, paymentId, signature)`:
  - HMAC-SHA256 of `"<order id>|<payment id>"` with the key secret, as Razorpay documents for Standard Checkout.
  - Compared in constant time (`timingSafeEqual`); a signature of another length never matches.
  - The secret stays a private field and appears in no output.
- **Adapter** `verifyReturn` (`adapter.ts`): after the 14.07 shape checks, the signature is checked over the order we stored, never the one the browser names. It answers `verified: true` with the payment id, or `verified: false`.
- **Service** `apps/api/src/payments/checkout-return.ts`:
  - An unverified return is a 400 (`fields.signature: "mismatch"`).
  - A verified one is answered from our records as before, now with `verified: true`. Nothing is recorded or moved.
- **OpenAPI:** the return answer gains `verified`; still 77 paths.
- **14.07 test:** its success reports are now signed as Razorpay signs them (with the fake test secret). All 8 of its tests still pass.

**Test:** CHV-S14-M08 is in `tests/security/payments/checkout-return.test.mjs`, 4 tests (12 with the 8 from 14.07; log `stage-14-08-checkout-signature.log`).

- **Tampered returns:** a correctly signed return verifies. Ten changed versions are each a 400, with nothing about the order or its payment changed:
  - the payment id changed by one character, or swapped for another valid-looking id;
  - one signature digit changed, near the start or at the end;
  - a signature made with the webhook secret or a guessed secret;
  - a signature over the payment and order the wrong way round, or over the order alone;
  - the signature in capitals, or all zeros.
- **Association:** another order's genuinely signed payment, relabelled with this order's Razorpay order id, is a 400 `mismatch`. Unrelabelled it is refused because it names their checkout. It still verifies against its own order.
- **Replay:** a valid signed return sent again and six times at once verifies each time and records nothing.
- **The check itself:**
  - It matches only the exact order, payment id and secret.
  - A shortened or empty signature never matches.
  - Another secret fails.
  - The secret is not in the configuration's JSON.

Command: `npm run build:api`, then `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/support/register.mjs --test tests/security/payments/checkout-return.test.mjs`. Result: 12 of 12.

**Also run:**
- All `tests/security/payments/*.test.mjs` with `tests/security/api/routes.test.mjs`, `tests/contracts/payment-adapter.test.mjs` and `tests/ops/env.test.mjs`: 95 of 95.
- `npm run api:openapi` 77 paths; `npm run typecheck` clean; `npm run lint` 0 errors, the 2 existing warnings.

**Mutation checks** (each applied, tested, then restored; the restored code passes 12 of 12; log `stage-14-08-mutations.log`). The first run showed that comparing only the first 8 bytes went unnoticed: every tampered signature differed early. A last-digit case was added, and that mutation is now caught.

| Mutation | Tests failing |
|---|---|
| Signature never checked | 2 of 12 |
| Unverified return accepted by the service | 2 of 12 |
| Signature over the order id only | 7 of 12 |
| Signature over the order and payment the wrong way round | 7 of 12 |
| Signature made with the webhook secret | 7 of 12 |
| Only the first 8 bytes compared | 1 of 12 (after the added case; 0 before) |
| Signature checked over the order the browser names | 0 of 12: the order-id match already forces it to be the stored order (a double guard) |
| Order match removed and signature over the browser's order | 2 of 12 |

**Not covered here:** no real Razorpay signature is checked (that needs a real sandbox payment); the formula is the one Razorpay documents for Standard Checkout.

**Defaults set here (owner to confirm at the Stage 14 gate):**

- **A verified return records nothing:** the payment id is not stored and no lookup is started. The payment moves only on Razorpay's own event or lookup (14.09 onwards). A later step could start an immediate lookup on a verified return to confirm sooner.

## 14.09 Raw webhook signature validation (CHV-S14-M09), 31 October 2026

**Status:** PASS (focused test; wider suites at the Stage 14 gate). Razorpay's webhook is received at `POST /api/webhooks/razorpay` on the web host and verified by the API before anything in it is read. Checks run in this order, and nothing is read before the one above it passes:
1. the signature over the exact bytes received;
2. the event id;
3. the event type and the entity that type must carry.

An invalid signature or a mutated body is a 400. A verified event is acknowledged; it is not stored or acted on yet (14.10 onwards).

**What changed**

- **Route** `POST /api/v1/webhooks/razorpay` (`apps/api/src/modules/webhooks.controller.ts`, new):
  - 404 in production, like the rest of payments; 503 when payments are off.
  - `no-store`, up to 600 a minute.
  - Answers `{ received: true, event: { type, eventId } | null }`.
- **Access** `apps/api/src/http/access.ts`: a new `@Access.webhook()` rule. No same-origin check and no session (Razorpay has neither); the web host's internal key is still required, so the API answers only through the forwarder.
- **Raw bytes:**
  - `apps/api/src/http/body.ts` keeps the exact bytes received (`RawBody.bytes`) next to the text.
  - The web host's forwarder already sends the body's bytes unchanged; it now also passes `X-Razorpay-Signature` and `X-Razorpay-Event-Id` (`lib/api/forward.ts`).
- **Contract:** `WebhookInput` gains an optional `rawBytes`. The 14.01 fakes are unaffected.
- **Signature** `RazorpayConfig.webhookSignatureMatches` (`config.ts`): HMAC-SHA256 of the raw bytes with the webhook secret (not the key secret), compared in constant time. Only lowercase 64-digit hex is accepted.
- **Adapter** `parseWebhook` (`adapter.ts`), in order:
  1. The signature over the bytes, before any parsing.
  2. The event id, 8 to 64 letters and digits.
  3. The body must be a Razorpay `event` with a lowercase dotted event name, a whole `created_at` and a payload.
  - Events we act on: `payment.authorized`, `payment.captured`, `payment.failed`, `refund.processed`, `refund.failed`. Each must carry a Razorpay payment (`pay_…`, for an `order_…`, a whole positive amount, INR). Refunds must also carry a refund (`rfnd_…`) for that same payment, in INR.
  - Any other signed event is valid with no event.
  - Normalized to `ProviderPaymentEventV1`, with a SHA-256 fingerprint of the verified bytes for 14.10.
- **Service** `apps/api/src/payments/webhook.ts` (new):
  - Over the read limit is a 413.
  - Anything that does not verify is a 400 with one message, so a caller cannot tell which check failed.
  - Our own headers (cookie, internal key) are never given to the adapter. Nothing is logged, stored or moved.
- **Schemas and gate:**
  - OpenAPI regenerated, 78 paths (was 77).
  - The Stage 12 checkout-gate test now lists the webhook path. Both of its web hosts answer 503 there, because that test's API has no payment key.

**Test:** `tests/security/payments/webhook-signature.test.mjs`, 14 tests (log `stage-14-09-webhook-signature.log`). Webhooks are built byte for byte and delivered through the web host's forwarder with no cookie or origin, as Razorpay calls; signatures use fake secrets.

- **Accepted:**
  - A signed `payment.captured` event is acknowledged with its type and id.
  - Odd spacing, key order and Hindi and ₹ text verify as sent.
  - A body with a byte that is not valid UTF-8 verifies over its bytes.
  - Events we do not act on (`order.paid`, a dispute, a settlement) are acknowledged with no event.
  - All five events we act on are normalized exactly: order, payment, refund, amount, fingerprint and time.
- **Invalid signatures (CHV-S14-M09):** 13 cases, each a 400 with the same message:
  - a missing or empty signature, non-hex, too short or too long, capitals;
  - the first or last digit changed;
  - made with the key secret or a guessed secret;
  - base64, two signatures joined, another event's signature.
- **Mutated bodies (CHV-S14-M09):** 14 cases, each a 400:
  - the amount lowered or raised;
  - another order or payment;
  - "captured" changed to "failed", or the currency changed;
  - a trailing newline, a leading space, the same JSON re-serialized with spacing;
  - a field added, one byte removed, an empty body;
  - the same text in UTF-16, a byte-order mark added.
- **The event must hold, even when signed:**
  - A missing or malformed event id is a 400.
  - 17 malformed events are each a 400: not JSON, an array, not an event, no event name, a name in capitals, no time, no payload, a payment event without its payment, a non-INR, zero, fractional or text amount, a payment id or order id not Razorpay's, a refund for another payment, a refund event with no refund, a non-INR refund.
- **Kept out:**
  - A valid event replayed six times is acknowledged each time, and nothing is stored or moved (no provider events, attempts or orders).
  - Calling the API without the web host's key is 401.
  - Production is 404; payments off is 503; a 70 KB body is 413.
  - No answer carries a secret or the signature.

Command: `npm run build:api`, then `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/support/register.mjs --test tests/security/payments/webhook-signature.test.mjs`. Result: 14 of 14.

**Also run:**
- After `npm run build`: all `tests/security/payments/*.test.mjs`, `tests/security/auth/admin-access.test.mjs` (every route has an access rule), `tests/contracts/payment-adapter.test.mjs`, `tests/ops/env.test.mjs`, `tests/e2e/checkout-gate.test.mjs` and `tests/e2e/payment-handoff.test.mjs`: all pass. The checkout gate failed once, because its production web host forwards to the test's development API; its webhook check was corrected to 503 for both hosts, and it passes 14 of 14.
- `npm run api:openapi` 78 paths; `npm run typecheck` clean; `npm run lint` 0 errors, the 2 existing warnings.

**Mutation checks** (each applied, tested, then restored; the restored code passes 14 of 14; log `stage-14-09-mutations.log`). The first run showed that checking the signature over the decoded text instead of the bytes went unnoticed: the two agree for valid UTF-8. A test with a byte that is not valid UTF-8 was added, and that mutation is now caught.

| Mutation | Tests failing |
|---|---|
| Signature never checked | 3 of 13 |
| Signature over re-serialized JSON, not the bytes | 2 of 13 |
| Signature over the decoded text, not the bytes | 1 of 14 (after the added test; 0 before) |
| Signature made with the key secret | 6 of 13 |
| Only the first 8 bytes compared | 1 of 13 |
| Event id not required | 1 of 13 |
| Payment entity not checked | refused by the compiler |
| Currency not checked | 1 of 13 |
| A refund for another payment accepted | 1 of 13 |
| Event name format not checked | 1 of 13 |
| Service accepts an unverified webhook | refused by the compiler |
| Route open in production | 1 of 13 |
| Forwarder drops the signature header | 5 of 13 |

**Not covered here:**
- No real Razorpay webhook is received: that needs the sandbox dashboard pointed at a public staging address. The formula and headers are the ones Razorpay documents.
- A verified event is not kept: until 14.10, an event delivered now is acknowledged and lost. Razorpay retries only on failures, so it would not resend it.

**Defaults set here (owner to confirm at the Stage 14 gate):**

- **Webhook address:** `https://<staging host>/api/webhooks/razorpay`, set in Razorpay's sandbox dashboard with the webhook secret, for the five events above.
- **Rate limit:** 600 a minute.
- **Invalid webhooks:** answered 400, so Razorpay retries anything that failed to verify (its usual retry schedule).

## 14.10 Webhook inbox with deduplication (CHV-S14-M10), 31 October 2026

**Status:** PASS (focused test; wider suites at the Stage 14 gate). Every verified Razorpay event we act on is kept once in a new inbox table, keyed by provider and event id, before Razorpay is told it was received.
- A duplicate delivery changes nothing.
- A different body under a kept id is a conflict, never stored over the first.
- If storing fails, Razorpay gets an error and delivers again.
- A worker side (claim, complete, retry, give up) runs each event's handler once. What the handler does to a payment or order is 14.11 onwards; no handler is registered yet.

**Why a new table, not `provider_event`.** `provider_event` is the record of events *applied* to a payment, written once by the Stage 13.10 capture bridge (`apps/api/src/orders/capture.ts`, which inserts its own row and treats an existing one as a duplicate). If the inbox wrote there first, the bridge would see every first capture as a duplicate and never confirm the order. The inbox therefore keeps deliveries and their processing; `provider_event` keeps applications. 13.10 is unchanged.

**What changed**

- **Migration** `20261031010000_payment_webhook_inbox` (rollback in `prisma/rollback/`), table `payment_webhook_inbox` and enum `WebhookInboxStatus` (`received`, `processing`, `processed`, `failed`):
  - **Kept:** the normalized event only: provider, event id, body fingerprint, type, Razorpay order, payment and refund ids, amount in paise (INR), the time it happened. Never the raw body or the signature.
  - **Processing:** status, attempts, when it is next due, the claim (claim id and lease), the last error, when a conflict was first seen, received and processed times.
  - **Database rules:**
    - one row per provider and event id;
    - a known event type, a positive amount in INR, ids present, attempts never negative;
    - a claim only while processing; a processed time exactly when processed;
    - the event's own fields never change, and attempts never go back;
    - status only moves forward, and processed and failed are final;
    - a conflict is noted once; rows are never deleted.
- **Prisma model** `PaymentWebhookInbox` in `schema.prisma` (the database matches it: no drift).
- **Inbox** `apps/api/src/payments/inbox.ts` (new):
  - `recordWebhookEvent`: an insert that ignores an existing row, then a fingerprint comparison: `stored`, `duplicate` (changes nothing) or `conflict` (first conflict noted, nothing else changes).
  - `claimWebhookEvents`: claims due events (received and past their wait, or processing with a lapsed lease), oldest first, skipping rows another worker holds, with a new claim id and a 2-minute lease.
  - `completeWebhookEvent`: done, only for the claim's holder, once.
  - `failWebhookEvent`: retried after 1 minute, 5 minutes, 30 minutes, then 2 hours, and given up as `failed` after 5 tries, for staff. The error text is kept to 300 characters.
  - `processWebhookInbox`: one worker pass that runs the handler once per claim.
- **Webhook** `apps/api/src/payments/webhook.ts` and `webhooks.controller.ts`: a verified event is kept before the answer; the answer says `inbox: stored | duplicate | conflict`. A verified event of a type we do not act on is acknowledged and not kept.
- **14.09 test:** its answer now includes `inbox: "stored"`, and its replay test checks that the event is kept once.
- **Schema test:** 45 tables (was 44).

**Test:** `tests/security/payments/webhook-inbox.test.mjs`, 10 tests (log `stage-14-10-webhook-inbox.log`). Webhooks are delivered through the web host's forwarder, signed with fake secrets. The handler is a stand-in that counts its runs.

- **Duplicates change nothing (CHV-S14-M10):**
  - A new event is kept once, as `received`. A private note from the body and the signature are not in the row.
  - Twelve repeats (two in turn, ten at once) are each `duplicate`, and the row is unchanged.
- **Race:** ten simultaneous first deliveries: exactly one `stored`, nine `duplicate`, one row.
- **Conflict:** the same id with another amount is `conflict`, and the first event is kept exactly as it was. A second conflict leaves the noted time unchanged.
- **Acknowledged only once kept:** with storage made to fail, the delivery gets a 500 and nothing is kept. The redelivery is `stored`. The error log names only the error, not the body or signature.
- **Unknown types:** `order.paid` is acknowledged and not kept.
- **Once on the worker side (CHV-S14-M10):**
  - An event delivered three times runs its handler once and ends `processed` after 1 attempt. A later duplicate does not reopen it.
- **Concurrency:** three workers at once over twelve events run every handler exactly once.
- **Retry:**
  - A failure goes back to `received` with the error and a 1-minute wait. It is not claimed before the wait, then succeeds once.
  - An event that keeps failing is given up as `failed` after 5 tries and is not claimed again.
- **Lapsed claim:**
  - A claim is held while its lease lasts, then taken over (attempt 2).
  - The first holder can no longer complete or fail it, and the second completes it once.
- **Database rules:** changing a kept event's amount, fingerprint or order is refused. So are received straight to processed, processed back to received, attempts going back, deleting, an unknown type, and a non-INR event.

Command: `npm run build:api`, then `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/support/register.mjs --test tests/security/payments/webhook-inbox.test.mjs`. Result: 10 of 10.

**Also run:**
- `npm run test:db`: 61 of 61 (the migration applies, the rollback rehearsal passes, no drift from `schema.prisma`, 45 tables).
- All `tests/security/payments/*.test.mjs` and `tests/security/orders/*.test.mjs` (including the 13.10 capture bridge and 13.11 late capture), `tests/security/auth/admin-access.test.mjs` and `tests/contracts/payment-adapter.test.mjs`: 273 of 273.
- `npm run api:openapi` 78 paths; `npm run typecheck` clean; `npm run lint` 0 errors, the 2 existing warnings.

**Mutation checks** (each applied, tested, then restored; the restored code passes 10 of 10, with 14.09's 14; log `stage-14-10-mutations.log`):

| Mutation | Tests failing |
|---|---|
| Insert without deduplication | 4 of 10 |
| Every delivery reported as newly stored | 3 of 10 |
| A different body under a kept id treated as a duplicate | 1 of 10 |
| Conflict noted on every conflicting delivery | 1 of 10 |
| Acknowledged without keeping the event | 9 of 10 |
| Claim without skipping rows another worker holds | 0 of 10: the waiting worker then finds the event claimed, so the result is the same, only slower (throughput, not correctness) |
| Claim takes events whose lease has not lapsed | 2 of 10 |
| Lapsed claims never taken over | 1 of 10 |
| Anyone may complete, not only the claim's holder | 1 of 10 |
| Retried at once, with no wait | 1 of 10 |
| Never given up | 1 of 10 |
| Database lets a processed event go back | 2 of 10 |
| Database lets a kept event's amount change | 2 of 10 |

**Not covered here:**
- Nothing runs the worker pass yet: no job in `apps/worker` calls `processWebhookInbox`, and no handler acts on an event. That arrives with 14.11 and 14.12.
- Received events wait in the inbox until then.

**Defaults set here (owner to confirm at the Stage 14 gate):**

- **Retries:** 5 tries, waits of 1 minute, 5 minutes, 30 minutes and 2 hours, then `failed` for staff.
- **Claim lease:** 2 minutes.
- **Conflicts:** acknowledged (200) so Razorpay stops resending, and noted for staff; the first body is kept.
- **Retention:** inbox rows are kept for good, like payment attempts.

## 14.11 Captured amount and currency validation (CHV-S14-M11), 31 October 2026

**Status:** PASS (focused test; wider suites at the Stage 14 gate). A reported capture is checked against Razorpay's own record of the payment, never the webhook's amount, and against the order. Only Razorpay's captured amount reaches the Stage 13.10 capture bridge. A captured wrong amount can never complete an order: the money is recorded and the order goes to review with its stock still held.

**What changed**

- **Razorpay lookup** (`adapter.ts`): `lookupPayment` and `captureStatus`, the authoritative answer.
  - `GET /v1/payments/{id}`, or `GET /v1/orders/{id}/payments` without a payment id (the captured payment first, else the latest).
  - Repeated like every lookup (14.05).
  - The answer must be a Razorpay payment: `pay_…` for an `order_…`, a whole positive amount, a currency, a status, a captured flag, a valid refunded amount and creation time. Anything else is an invalid response, never guessed at.
  - A 404 is "not found".
  - Status in provider-neutral words: `captured`, `partially_refunded`, `refunded`, `authorized`, `failed`, `created`, otherwise `unknown`.
  - The captured amount is set only when Razorpay says `captured: true`.
- **Contract:** `ProviderPaymentV1` gains an optional `reportedCurrency`, the currency exactly as the provider reported it. `amount` stays typed INR, and this says whether the provider agrees. The 14.01 fakes are unaffected.
- **Check** `apps/api/src/payments/verify-capture.ts` (new), `verifyCapture(db, adapter, event)`:
  - The attempt is found by the Razorpay order we opened. Its amount must equal the order's grand total, both in INR.
  - Razorpay is then asked. Its payment must be for that Razorpay order and be the payment the event names.
  - The verdict:
    - `verified`: captured, INR, exactly the order total.
    - `mismatch`: captured, INR, another amount.
    - `rejected`: another order's or another payment's money, or not INR. Never applied.
    - `not_captured`: authorized, failed, created or not found.
    - `no_attempt`: a Razorpay order we never opened; Razorpay is not asked.
  - A Razorpay that cannot be asked is passed on as a retryable error, so the 14.10 inbox retries the event.
  - `captureInputFor(verdict, event)` gives the capture bridge Razorpay's amount, in INR, for `verified` and `mismatch` only. A mismatch is recorded as captured money, and the bridge's own rule sends the order to `needs_review` with the stock held. Nothing else reaches the bridge.

**Test:** `tests/security/payments/verify-capture.test.mjs`, 11 tests (log `stage-14-11-verify-capture.log`). Real pending orders are placed and their checkouts opened through the web host's forwarder. Razorpay is a stand-in whose payments each test sets. Each case runs the check, then the 13.10 capture bridge with whatever the check allows, as the 14.12 handler will.

- **The right amount completes the order:** the exact total in INR is `verified`. The stock is allocated and the order confirmed, and Razorpay itself was asked.
- **A wrong amount cannot complete it (CHV-S14-M11):** one paisa less, one paisa more, and half the total are each `mismatch`, even though the webhook claimed the right amount. The money is recorded as captured, the order is `needs_review`, and the stock hold is still `active`. Never confirmed.
- **The webhook's amount does not count:** a webhook claiming ₹1 for a full capture is `verified` with Razorpay's amount.
- **Another currency:** a capture reported in USD is `rejected` and nothing changes.
- **Another order's or another payment's money:** another shopper's payment is `rejected` (order). Razorpay answering with another payment id than the one asked for is `rejected` (payment). Nothing changes.
- **Not a capture:** authorized, failed, created and unknown to Razorpay are `not_captured`, and nothing is applied.
- **Razorpay down:** the error is retryable and nothing is decided. The retry confirms once, and the same event again is a duplicate.
- **Race:** five simultaneous deliveries of a mismatched capture leave one review, never a confirmation.
- **Never opened:** an event for a Razorpay order we never opened finds no attempt and asks Razorpay nothing.
- **The lookup:**
  - Mapped exactly by id, including a partly refunded payment.
  - By order it picks the captured payment over a newer failed one.
  - A failed payment's capture state is `failed`, and an unknown payment is `not_captured`.
  - Eight malformed answers are never believed: an amount as text, fractional or zero; another entity; a captured flag as text; a bad order or payment id; a negative refund.
  - It is repeated after two 503s, and ids not in Razorpay's format are refused before asking.

Command: `npm run build:api`, then `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/support/register.mjs --test tests/security/payments/verify-capture.test.mjs`. Result: 11 of 11.

**Also run:**
- All `tests/security/payments/*.test.mjs`, all `tests/security/orders/*.test.mjs` and `tests/contracts/payment-adapter.test.mjs` together, twice. The first run had 268 of 271; the second 270 of 271.
- The failures were in Stage 13 tests (`cancel`, `payment-fulfilment` and `events`), in tests this stage does not touch. Run on their own, those three files pass 33 of 33.
- The one that repeated, `events.test.mjs` "every move after placing is recorded once", sorts the order's trail by time. Under the combined load the order-placed and payment events can share a millisecond and swap places. This is an existing timing weakness in the test, recorded for the Stage 14 gate.
- `npm run typecheck` clean; `npm run lint` 0 errors, the 2 existing warnings.

**Mutation checks** (each applied, tested, then restored; the restored code passes 11 of 11; log `stage-14-11-mutations.log`). All 12 caught.

| Mutation | Tests failing |
|---|---|
| The webhook's amount used instead of Razorpay's | 3 of 11 |
| Amount not compared with the order | 2 of 11 |
| A mismatch handed on as verified (with the order's amount) | 2 of 11 |
| A mismatch never recorded (captured money ignored) | 2 of 11 |
| Currency not checked | 1 of 11 |
| Another order's payment accepted | 1 of 11 |
| Another payment than the event names accepted | 1 of 11 |
| Authorized treated as captured | 1 of 11 |
| Razorpay not asked (the event trusted) | 7 of 11 |
| A provider that cannot be asked read as not captured | 1 of 11 |
| A lookup answer's amount not checked as whole paise | 1 of 11 |
| A lookup by order picks the newest, not the captured, payment | 1 of 11 |

**Not covered here:**
- Nothing calls the check from the inbox yet: the worker job and its handler are 14.12.
- No real Razorpay payment is looked up: the fields are the ones Razorpay documents for its payments API.

**Defaults set here (owner to confirm at the Stage 14 gate):**

- **A wrong captured amount:** recorded and the order sent to review with stock held, for staff to refund the difference or the whole, or to accept by hand. This is the 13.10 bridge's existing rule.
- **Another currency, or another order's payment:** never applied to the order and kept for staff and reconciliation (14.14). No refund is started automatically.
- **Flaky test:** the order-trail ordering in `events.test.mjs` should be fixed to sort by sequence rather than time (a Stage 13 test, not changed here).

## 14.12 Payment-to-order transaction (CHV-S14-M12), 31 October 2026

**Status:** PASS (focused test; wider suites at the Stage 14 gate). A captured payment now confirms its order end to end:
1. a signed webhook is kept once in the inbox (14.10);
2. a worker job claims it;
3. the capture handler asks Razorpay what was captured (14.11);
4. the Stage 13.10 capture bridge applies it.

Step 4 is one transaction that records the event once, captures the payment, allocates the held stock through the Stage 09 ledger, confirms the order and writes one `order.paid` outbox event. A crash at any point, or any replay, cannot confirm an order, move its stock or announce it twice.

**What changed**

- **Handler** `apps/api/src/payments/capture-handler.ts` (new), `captureHandler(db, adapter)`, for `payment.captured` events:
  - A capture Razorpay does not show yet is retried (the inbox's waits, then `failed` for staff).
  - `rejected` (another currency, order or payment) and `no_attempt` are noted once for staff in the audit trail (`payment.capture_rejected`, `payment.capture_unmatched`), never applied.
  - `verified` and `mismatch` go to the bridge with Razorpay's own amount.
  - The correlation id is `inbox:<inbox id>`, the same on every run of the event.
- **Outbox** `apps/api/src/orders/capture.ts` and `apps/api/src/outbox/outbox.ts`: on confirmation the bridge writes `order.paid` (order id and number, payment attempt, captured paise, INR) in the same transaction. A replay never reaches that point again.
- **Inbox** `apps/api/src/payments/inbox.ts`: claims can be limited to the event types a worker handles. `payment.failed` and refund events stay `received` for the steps that handle them (14.13, 14.16).
- **Worker:**
  - `apps/worker/src/jobs/payment-inbox.ts` (new): every 15 seconds, up to 10 captured-payment events. It does nothing when payments are off.
  - Registered in `apps/worker/src/main.ts` (lock key 7015).
  - The outbox job delivers `order.paid`: logged (ids and amount only) until notifications exist.
- **Package:** `apps/api/package.json` exports `payments/*` and `integrations/*` to the worker, as it already did `orders/*` and `outbox/*`.

**Test:** `tests/security/payments/payment-to-order.test.mjs`, 10 tests (log `stage-14-12-payment-to-order.log`).
- Orders are placed and checkouts opened through the web host's forwarder.
- Webhooks are signed and delivered through it.
- Razorpay is a stand-in whose payments each test sets.
- Every test counts each effect of a confirmation: order status, payment status and amount, the stock balance, confirmations in the order trail, `order.paid` events, recorded provider events, and allocation movements.

- **The whole path:**
  - The webhook alone changes nothing.
  - One worker run then captures the payment, allocates the stock (reserved 1 to allocated 1) and confirms the order.
  - It also writes exactly one `order.paid` with the right payload, and marks the event `processed`.
- **A crash inside the transaction (CHV-S14-M12):** the `order.paid` write fails. Payment, stock, order, event record and outbox are all rolled back together. The retry after its wait confirms once.
- **A crash at commit (CHV-S14-M12):** a deferred check fails only as the transaction commits, after every write. Nothing is committed, so no `order.paid` exists for an unconfirmed order. The retry confirms once.
- **A crash after commit (CHV-S14-M12):**
  - A worker confirms the order, then dies before marking the event done.
  - Another worker takes the lapsed claim and runs the event again: nothing changes (one confirmation, one allocation, one `order.paid`), and the event ends `processed` after 2 attempts.
  - The dead worker's claim is void.
- **Replays:**
  - The same webhook again is `duplicate`.
  - Three more events for the same payment under new ids, run by three workers at once, still give one confirmation. Each of the four events is recorded once.
  - Six events for another order's payment, three workers at once: one confirmation.
- **A wrong amount:** one paisa short, delivered twice, goes to review once. The stock stays held, with no confirmation and no `order.paid`.
- **Not yet captured at Razorpay:** retried; confirmed once Razorpay shows the capture.
- **Another currency at Razorpay:** the webhook claims INR, Razorpay's own record says USD. Never applied, and noted for staff once even though the event ran twice.
- **Not this handler's events:** a `payment.failed` event stays `received`. With payments off, the job does nothing.
- **Outbox delivery:** the outbox job delivers `order.paid` without error.

Command: `npm run build:api`, then `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/support/register.mjs --test tests/security/payments/payment-to-order.test.mjs`. Result: 10 of 10.

**Also run:**
- `npm run test:db` 61 of 61; `npm run typecheck` clean (API and worker); `npm run lint` 0 errors, the 2 existing warnings.
- All `tests/security/payments/*.test.mjs`, all `tests/security/orders/*.test.mjs` and `tests/contracts/payment-adapter.test.mjs` with at most 4 files at once (`--test-concurrency=4`): 280 of 280.
- With no limit (about 30 files at once) the same set had 6 failures. They came from "Too many database connections opened: sorry, too many clients already", and one Stage 13 race test that was slowed by it.
- This is also what caused the Stage 13 failures seen in 14.11. They are a test-load problem, not a code problem; the gate run should limit concurrency.

**Mutation checks** (each applied, tested, then restored; the restored code passes 10 of 10; log `stage-14-12-mutations.log`). The first run showed that writing `order.paid` outside the confirming transaction went unnoticed: the crash test failed at the outbox write itself, which looks the same either way. The crash-at-commit test was added, and that mutation is now caught.

| Mutation | Tests failing |
|---|---|
| No `order.paid` outbox event | 6 of 9 |
| `order.paid` written on every capture call, replays too | 6 of 9 |
| Outbox written outside the confirming transaction | 1 of 10 (after the added test; 0 before) |
| A capture Razorpay does not show yet is dropped, not retried | 1 of 9 |
| Rejected money applied anyway | 1 of 9 |
| Staff note written on every run | 1 of 9 |
| Inbox marks the event done before the handler runs | 4 of 9 |
| Worker claims every event type | 5 of 9 |
| Bridge forgets which events it has recorded | 0 of 9: the payment's own "already captured" check still stops a second confirmation (a double guard, as in 13.10) |
| Handler trusts the webhook instead of asking Razorpay | 2 of 9 |

**Not covered here:**
- The worker process itself was not started: the job is run directly, as the other worker job tests do.
- No buyer or staff notification is sent for `order.paid` (a later stage); it is logged.

**Defaults set here (owner to confirm at the Stage 14 gate):**

- **Worker cadence:** every 15 seconds, 10 events a run.
- **Staff notes:** an unmatched or rejected capture is an audit record only for now. The 14.14 reconciliation job and the admin's recovery cases (13.14) are where staff will see it.
- **Test runs:** the gate's full suite should run with limited concurrency (`--test-concurrency=4`) so the local Postgres is not out of connections.

## 14.13 Failed, cancelled and expired payments (CHV-S14-M13), 31 October 2026

**Status:** PASS (focused test; wider suites at the Stage 14 gate). A failed payment never pays an order. Failed, shopper-cancelled and expired payments are now told apart by what Razorpay itself says, and the buyer's retry and the stock rules are kept.

**The rule, and why.** Razorpay keeps an order open after a failed try, so the buyer can try again in the same window with another card or UPI app, and that try may succeed. If a failed try ended our attempt, a successful retry minutes later would reach a closed attempt: the money would go to staff for a refund instead of confirming the order. So:
- **A failed try** (a verified `payment.failed`) is recorded for staff and ends nothing. The attempt stays open, the stock stays held, and the pay page reopens the same Razorpay checkout.
- **An attempt ends** only when its order is given up: the shopper cancels, or the payment window ends. Razorpay is asked first:
  - **Captured, authorized or still in progress:** nothing is closed; the capture flow decides.
  - **Only failed tries:** the attempt ends `failed`.
  - **No payment at all, or no checkout ever opened:** it ends `expired`.
  - With the attempt closed, the Stage 13.09 cancellation releases the stock and cancels the order.

**What changed**

- **Failure handler** `apps/api/src/payments/failure-handler.ts` (new):
  - For `payment.failed` events from the inbox, Razorpay is asked about the payment. Only one it holds as `failed`, for our Razorpay order, is recorded (`payment.try_failed`, once per event).
  - A payment Razorpay now shows as captured is a late success, left to the capture flow. An unknown payment is ignored. An event for a Razorpay order we never opened is noted once.
- **Closing** `apps/api/src/payments/close-attempt.ts` (new):
  - `closeOpenAttempt` asks Razorpay outside the transaction. It then locks the order, then the attempt (the capture bridge's order, so the two never deadlock), re-checks the attempt and moves it.
  - `failed` is moved by the provider (`provider_reports_failed`). `expired` from `created` is moved by the system (`session_ttl_passed_without_payment`), and from `pending_reconciliation` by the provider.
  - `shopperCancelsWithPayment` closes the shopper's own open attempts first, then runs the 13.09 cancellation. Another shopper's order is the same 404, and nothing of it is read.
- **Cancel route** `POST /api/v1/cart/order/{orderId}/cancel`: now closes an opened checkout first. If Razorpay cannot be asked, it is a 502 and nothing is cancelled. With payments off it behaves exactly as in 13.09.
- **Razorpay lookup by order** (`adapter.ts`): a captured payment first, then one authorized or still in progress, and only then the latest. A newer failed try can never hide a payment that went through.
- **Worker:** the inbox job now takes `payment.captured` and `payment.failed` (`paymentEventsHandler` in `capture-handler.ts`). Refund events still wait for 14.16.

**Test:** `tests/security/payments/failed-payments.test.mjs`, 11 tests (log `stage-14-13-failed-payments.log`). Orders are placed, checkouts opened and orders cancelled through the web host's forwarder. Webhooks are signed and delivered through it; Razorpay is a stand-in whose payments each test sets.

- **A failed try pays nothing (CHV-S14-M13):**
  - A verified `payment.failed`, delivered twice and processed by two workers at once, is recorded once.
  - The order stays `pending_payment`, the attempt `created`, the stock held (reserved 1), with no `order.paid`.
  - Opening the checkout again returns the same attempt and Razorpay order.
- **Retry succeeds:** two failed tries, then a captured third in the same window. The order is confirmed once, with the stock allocated and one `order.paid`.
- **Not believed:** a `payment.failed` for a payment Razorpay holds as captured, and one for a payment Razorpay does not have, record nothing and change nothing.
- **Shopper cancels after failed tries:**
  - The attempt ends `failed` (moved by the provider), the order is cancelled and the stock released.
  - Paying again is refused (409), and cancelling again is a no-op.
- **Shopper cancels with no payment:** with a checkout opened but nothing at Razorpay, the attempt ends `expired` (moved by the system). With no checkout at all, cancellation works as in 13.09.
- **Money in flight:** with a captured, authorized or still-in-progress payment behind a newer failed try, cancelling is `awaiting_payment_outcome`. Nothing is closed and the stock stays held.
- **Razorpay down:** cancelling is a 502 and nothing changes. Cancelling again later works.
- **Another shopper:** cannot cancel or close my attempt (404).
- **Window ended:** the expiry job holds the order (`pending_reconciliation`). Closing it by Razorpay's word gives `expired`, and the next expiry run cancels the order and releases the stock.
- **Too late:** after a cancellation closed the attempt `failed`, a payment captured in another tab is verified but not applied (`conflict`, kept for reconciliation and a refund). The order stays cancelled and is never paid.
- **Race:** five simultaneous closes move the attempt once.

Command: `npm run build:api`, then `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/support/register.mjs --test tests/security/payments/failed-payments.test.mjs`. Result: 11 of 11.

**Also run:**
- All `tests/security/payments/*.test.mjs`, all `tests/security/orders/*.test.mjs` (including 13.09 cancellation), `tests/contracts/payment-adapter.test.mjs` and `tests/security/auth/admin-access.test.mjs`, with `--test-concurrency=4`: 305 of 305.
- `npm run typecheck` clean (API and worker); `npm run lint` 0 errors, the 2 existing warnings.

**Mutation checks** (each applied, tested, then restored; the restored code passes 11 of 11; log `stage-14-13-mutations.log`). Two first versions did not compile and were rewritten (second section of the log).

| Mutation | Tests failing |
|---|---|
| A failed try ends the attempt (the retry on the same checkout lost) | 2 of 11 |
| A failed try believed without asking Razorpay | 1 of 11 |
| Closing does not ask Razorpay (money in flight closed over) | 4 of 11 |
| No payment read as failed (`expired` never used) | 2 of 11 |
| A newer failed try hides an earlier payment in progress | 1 of 11 |
| Cancel ignores the checkout (as before 14.13) | 4 of 11 |
| Razorpay down read as "no payment" | 1 of 11 |
| Another shopper's attempts closed | 1 of 11 |
| Status not re-checked under the lock | 0 of 11: the transition's own compare-and-set (13.06) still moves the attempt once (a double guard) |

**Not covered here:**
- The expiry job does not itself ask Razorpay yet: it holds the order as `pending_reconciliation`, and `closeOpenAttempt` is what the reconciliation job (14.14) will call.
- Razorpay's own failure reason (error code) is not kept, only that the try failed.
- The pay page has no "Cancel order" button: the route exists, but the UI is not built.

**Defaults set here (owner to confirm at the Stage 14 gate):**

- **Failed tries:** a failed try ends nothing. The buyer can keep trying until they cancel or the window ends, and the stock stays held all that time.
- **Cancel when money may be in flight:** refused (`awaiting_payment_outcome`) until Razorpay settles it.
- **Paid after cancelling:** a payment captured after its attempt was closed (another tab, last moment) is kept for staff to refund, never applied to the cancelled order.

## 14.14 Payment-status reconciliation job (CHV-S14-M14), 31 October 2026

**Status:** PASS (focused test; wider suites at the Stage 14 gate). Webhooks can be lost, so a new worker job asks Razorpay directly about every attempt whose outcome we do not know. It settles each one through the same checked code a webhook reaches. A missing webhook now reconciles correctly:
- the paid order is confirmed once;
- a window that ended with only failed tries or no payment is closed, and the order is cancelled with its stock released;
- money in progress is left alone.

The job respects Razorpay's limits and keeps the last recoverable error for staff.

**What changed**

- **Migration** `20261031020000_payment_reconciliation` (rollback in `prisma/rollback/`), table `payment_reconciliation`, one row per attempt the job has asked about.
  - **Columns:** checks, last checked, last outcome, last error (300 characters at most), next check.
  - **Database rules:** a known outcome only, a count that never goes back, rows never deleted.
  - Prisma model `PaymentReconciliation` (no drift).
- **Reconciliation** `apps/api/src/payments/reconcile.ts` (new), `reconcilePayments(db, adapter, { now, limit })`:
  - **Asked about:**
    - attempts being reconciled (`pending_reconciliation`, which the order expiry job sets when a window ends with a checkout open);
    - open checkouts (`created` or `authorized`) that have heard nothing for 10 minutes, the quiet period, since the buyer may have paid and the webhook gone missing.
    - Only those due for their next check, oldest first.
  - **Settled:**
    - **Captured at Razorpay:** checked by `verifyCapture` (14.11) and applied by the 13.10 capture bridge under the lookup event id `lookup:<payment id>`, so a webhook for the same payment, before or after, never applies twice. Money for another currency or order is noted once for staff and never applied.
    - **Only failed tries, or nothing:** the attempt is still open while the window lasts. Once it ends, it is closed `failed` or `expired` by the 14.13 closing step, and the order expiry job then cancels the order and releases the stock.
    - **Authorized or in progress:** left, and asked about again.
  - **Limits:**
    - at most 20 attempts a run;
    - each attempt waits 2, 5, 15, 30 and 60 minutes, then 6 hours, between checks;
    - a provider that cannot answer stops the run at its first failure, so the waits space out the next tries.
  - **Errors:** the outcome and the error text are kept on the attempt's record (`provider_unavailable` or `provider_error`).
- **Worker** `apps/worker/src/jobs/payment-reconciliation.ts` (new): every minute, lock key 7016. It does nothing when payments are off. Registered in `apps/worker/src/main.ts`.
- **Schema test:** 46 tables (was 45).

**Test:** `tests/security/payments/reconcile.test.mjs`, 12 tests (log `stage-14-14-reconcile.log`). Orders are placed and checkouts opened through the web host's forwarder. Razorpay is a stand-in whose payments each test sets; the clock is moved forward instead of waiting.

- **A missing webhook reconciles (CHV-S14-M14):**
  - The buyer paid and no webhook came. Inside the quiet period nobody asks.
  - After it, one run confirms the order once: payment captured, stock allocated, one `order.paid`. The event is recorded once under its lookup id.
  - The settled attempt is not asked about again.
- **No double effect with webhooks:**
  - The late webhook for a payment the job settled changes nothing.
  - A payment a webhook already settled is never asked about: no call to Razorpay.
  - Two runs at the same moment with the webhook arriving too still confirm once.
- **A wrong amount:** captured one paisa short with no webhook, it goes to review once (stock held), never confirmed, over two runs.
- **Another currency:** never applied over five runs, and noted for staff once.
- **Only failed tries:**
  - Still open while the window lasts, and not asked again before its wait.
  - Closed `failed` when the window ends; the expiry job then cancels the order and releases the stock.
- **No payment at all:** the expiry job holds the order, the reconciliation closes it `expired`, and the next expiry run cancels it.
- **Money in progress:** an authorized payment is never closed over, however late. Its waits grow (2 minutes, then 5).
- **Batch limit:** twenty-five quiet paid checkouts are asked about over two runs (20, then 5), and each is confirmed once.
- **Razorpay down:**
  - The first failure stops the run: 1 checked, 1 error, and the second attempt is not asked.
  - The error is kept ("Razorpay answered 503").
  - The next run after the wait settles both.
- **The job:** idle with payments off; with them on it reconciles on its clock.
- **The record:** its count cannot go back, it cannot be deleted, and an unknown outcome is refused.

Command: `npm run build:api`, then `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/support/register.mjs --test tests/security/payments/reconcile.test.mjs`. Result: 12 of 12.

**Also run:**
- `npm run test:db` 61 of 61 (no drift, rollback rehearsal, 46 tables).
- All `tests/security/payments/*.test.mjs`, all `tests/security/orders/*.test.mjs`, `tests/contracts/payment-adapter.test.mjs` and `tests/security/auth/admin-access.test.mjs` with `--test-concurrency=4`: 317 of 317.
- `npm run typecheck` clean (API and worker); `npm run lint` 0 errors, the 2 existing warnings.

**Mutation checks** (each applied, tested, then restored; the restored code passes 12 of 12; log `stage-14-14-mutations.log`):

| Mutation | Tests failing |
|---|---|
| Quiet checkouts never asked about (missing webhooks lost) | 10 of 12 |
| No quiet period (asks while a webhook may still come) | 1 of 12 |
| Backoff ignored (asked every run) | 2 of 12 |
| No batch limit | 1 of 12 |
| Run not stopped when the provider fails | 1 of 12 |
| Capture applied under a fresh event id each run | 0 of 12: the payment's own "already captured" check stops a second application, and a settled attempt is never asked again (a double guard) |
| Any capture applied without `verifyCapture` | 1 of 12 |
| Closed before the window ends | 1 of 12 |
| Money in progress closed over | 0 of 12: the 14.13 closing step asks Razorpay again before closing and refuses (a double guard) |
| Recoverable error not kept | 1 of 12 |
| Staff note on every run | 1 of 12 |
| Wait does not grow | 1 of 12 |

**Not covered here:**
- No real Razorpay rate limit is exercised: the batch, the waits and the stop on failure keep the job at most 20 order lookups a minute (each closing adds one more lookup), well inside Razorpay's documented limits.
- The worker process itself was not started (the job is run directly, as other worker job tests do).

**Defaults set here (owner to confirm at the Stage 14 gate):**

- **Cadence:** every minute, 20 attempts a run.
- **Quiet period:** 10 minutes before an open checkout is asked about.
- **Waits:** 2, 5, 15, 30, 60 minutes, then every 6 hours. There is no cutoff: an unsettled attempt is asked about until it settles, and stays visible to staff as a 13.14 recovery case.

## 14.15 Safe payment retry flow (CHV-S14-M15), 31 October 2026

**Status:** PASS (focused test; wider suites at the Stage 14 gate). Paying again can no longer charge twice or fulfil twice:
- While an attempt is in progress, every retry gets that attempt. A payment whose outcome is unknown or authorized refuses a retry.
- A new attempt replaces ended ones only once Razorpay confirms nothing was paid, authorized or is in progress on their checkouts.
- Money that reaches Razorpay twice anyway (an old tab paid at the last moment) is never applied twice. The order is confirmed and its stock allocated once, and the second payment is kept for a refund.

**What changed**

- **Retry rule** `apps/api/src/payments/start.ts`, `assertEarlierAttemptsSettled`. When no attempt is in progress, Razorpay is asked about each ended attempt that opened a checkout, whether it ended `failed` or `expired`. This is needed because Razorpay keeps an ended attempt's order payable.
  - **Only failed tries, or nothing:** a new attempt and a new checkout are opened.
  - **Captured, authorized or in progress:** refused (409 `earlier_attempt_unsettled`), with nothing opened and no second checkout that could be paid. Staff are told once per ended attempt (`payment.retry_blocked`).
  - **Razorpay cannot answer:** refused (502, try again), since the outcome is not known.
- **Unchanged and relied on:**
  - one attempt in progress per order (14.03), with the same attempt for every retry, key or tab (14.04);
  - a payment under way is a 409;
  - a new attempt needs the order pending and its window open;
  - a capture on an ended attempt, or on an order already confirmed, is never applied to stock (13.10, 13.11).
- **Fixed, found here (a 14.10 weakness):** the inbox stamps when an event is due with the database's clock, but claimed events with the host's clock. With the database about 5 ms ahead (measured: 4 to 5 ms), an event stored a moment earlier looked not due yet.
  - In the payment-to-order and failed-payment tests this showed up as failures that had passed the day before.
  - `claimWebhookEvents` now uses the database's clock when no time is given, and tests pass a time only when they step forward on purpose.
  - A regression test was added to `tests/security/payments/webhook-inbox.test.mjs`.

**Test:** `tests/security/payments/payment-retry.test.mjs`, 9 tests (log `stage-14-15-payment-retry.log`).
- Orders are placed and checkouts opened through the web host's forwarder.
- Razorpay is a stand-in whose payments each test sets.
- An ended attempt is made by a provider-origin transition, as a verified provider event would make it.
- Every test counts the order's state, its attempts, how many were captured, the stock, confirmations and `order.paid` events.

- **In progress:** the same key, a new key and ten retries at once all get the one attempt and Razorpay order.
- **Unknown or authorized:** retrying is refused (409), with no new attempt and no new Razorpay order.
- **Safe to retry:**
  - With only failed tries on the ended checkout, a new attempt and Razorpay order are opened.
  - Paying it confirms the order once: attempts `failed, captured`, one captured, stock allocated once, one confirmation, one `order.paid`.
- **Not safe to retry (CHV-S14-M15):** an ended checkout that was paid anyway (captured, authorized or in progress behind a newer failed try).
  - Two retries are each refused, with no new attempt or Razorpay order.
  - Staff are told once.
- **Every ended checkout counts:** an older ended checkout paid late refuses the retry, even though the latest one is clean.
- **Razorpay down:** refused (502) with nothing opened. Later, with nothing at Razorpay, the new attempt is opened.
- **Race:** five simultaneous retries after an ended attempt open exactly one new attempt.
- **Paid twice at Razorpay (CHV-S14-M15):**
  - The new attempt is paid and confirms the order. The old tab's checkout is then paid too.
  - The second capture is a conflict, kept for a refund. The order is still confirmed once, captured once, allocated once, with fulfilment untouched.
- **After paying:** paying again is refused and opens nothing. The same capture again is `already_applied`.

Command: `npm run build:api`, then `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/support/register.mjs --test tests/security/payments/payment-retry.test.mjs`. Result: 9 of 9.

**Also run:**
- All `tests/security/payments/*.test.mjs` (with the inbox clock fix and its regression test), all `tests/security/orders/*.test.mjs`, `tests/contracts/payment-adapter.test.mjs` and `tests/security/auth/admin-access.test.mjs` with `--test-concurrency=4`: 327 of 327.
- Before the clock fix the same set had 10 failures; after it, it passed twice running.
- `npm run typecheck` clean; `npm run lint` 0 errors, the 2 existing warnings.

**Mutation checks** (each applied, tested, then restored; the restored code passes 9 of 9; log `stage-14-15-mutations.log`). The first run showed that checking only the latest ended attempt went unnoticed: every test had one. The two-ended-attempts test was added, and that mutation is now caught.

| Mutation | Tests failing |
|---|---|
| Ended attempts never checked (as before 14.15) | 2 of 8 |
| Only captured money blocks a retry (authorized or in progress ignored) | 1 of 8 |
| Razorpay down read as safe | 1 of 8 |
| Staff told on every retry | 1 of 8 |
| Only the latest ended attempt checked | 1 of 9 (after the added test; 0 before) |
| Expired attempts not checked | 1 of 8 |
| A payment under way does not refuse the retry (the check before the lock) | 0 of 8: the same check under the attempt's lock still refuses (the 14.04 double guard) |

**Not covered here:**
- An ended attempt is made directly in the test. In normal use attempts end through the 14.13 closing step, which also cancels the order, so a retry on a pending order after an ended attempt is the rarer path this rule guards.
- The pay page shows the 409 refusal's message but has no dedicated wording for it.

**Defaults set here (owner to confirm at the Stage 14 gate):**

- **A retry blocked by money on an earlier checkout:** the buyer is told "a payment for this order may already have gone through; we are checking it", and staff see `payment.retry_blocked`. The order waits for reconciliation or staff; no new checkout is offered.
- **Paid twice at Razorpay:** the second payment is kept for a refund (refunds arrive in 14.16), never applied.

## 14.16 Basic refund-provider adapter (CHV-S14-M16), 31 October 2026

**Status:** PASS (focused test; wider suites at the Stage 14 gate). Staff with refund permission can refund part or all of a captured payment through Razorpay's sandbox.
- **Who:** staff with `refunds.approve` and a two-factor session, within their limit (ADMIN up to ₹10,000, OWNER without limit).
- **How much:** never more than is still refundable by Razorpay's own record of the payment.
- **Recorded:** Razorpay's refund id and status are kept, and the refund webhooks waiting in the inbox since 14.10 now finish a pending refund.
- **No shortcut:** there is no storefront route, and no page or component calls the refund route.

**What changed**

- **Razorpay adapter** (`adapter.ts`), `refund` and `lookupRefund`, completing the 14.01 contract:
  - `POST /v1/payments/{id}/refund` for the amount, with our refund key in the notes.
  - Razorpay is asked for a refund with that key before one is made, and again after any answer that may have been lost (14.05's rule), so a retry never refunds twice.
  - The answer must be a refund of that payment, for exactly the amount, in INR. At least ₹1, whole paise, INR only.
  - Refund statuses in provider-neutral words (`pending`, `processed`, `failed`, `unknown`).
  - `lookupRefund` reads `GET /v1/refunds/{id}`.
- **Refund service** `apps/api/src/payments/refund.ts` (new), `requestRefund`:
  - **Permission:** checked by the route (`refunds.approve`, two-factor, admin host). The amount must be within the approver's limit (`auth/policies.ts`, decision 030), or it is a 403 `over_limit`.
  - **Payment:** only a captured or partly refunded payment, with the provider in use.
  - **Paid amount:** Razorpay is asked about the payment itself. Its captured amount must match ours, in INR (409 `provider_mismatch` otherwise). The refundable balance is the captured amount less the larger of what Razorpay has refunded and what we have under way or done; above it is a 409 `over_refundable`, with the balance.
  - **Once:** under the payment attempt's lock, the refund row is written (requested, then processing by the staff member's approval, audited as `refund.approved`) before Razorpay is asked. Simultaneous or repeated requests cannot pass the paid amount. The same Idempotency-Key returns the same refund; the same key with another amount is a 409; a missing key is a 428.
  - **Answer:** Razorpay's refund id is recorded once and its status followed:
    - **Processed:** the refund `succeeded`, and the payment becomes `partially_refunded` or `refunded`.
    - **Pending:** waits for Razorpay's webhook.
    - **Refused by Razorpay:** the refund `failed` (409 `provider_rejected`).
    - **Outcome unknown:** 502; retrying with the same key resumes it.
  - **Webhooks:** `refundEventHandler` asks Razorpay about the refund itself, and only a refund of ours, for its own payment and amount, moves. The worker's inbox job now also takes `refund.processed` and `refund.failed`.
- **Route** `POST /api/v1/admin/payments/{attemptId}/refunds` (`refund-admin.controller.ts`, new):
  - Body `{ amountPaise, reason }` and nothing else; `no-store`; rate limited.
  - 404 in production (payments are sandbox only); 503 when payments are off.
- **Schemas and gate:**
  - OpenAPI regenerated, 79 paths (was 78).
  - The Stage 12 checkout-gate test lists the refund route among the payment paths.

**Test:** `tests/security/payments/refund.test.mjs`, 17 tests (log `stage-14-16-refund.log`).
- Orders are placed, paid (through the 13.10 bridge, as a verified capture is) and refunded through the web host's forwarder.
- Staff sign in with two-factor.
- Razorpay is a stand-in that keeps its payments and refunds.
- In two race tests the stand-in does not check the balance itself, so only our own checks can stop an over-refund.

- **Permission (CHV-S14-M16):**
  - A visitor (401), a customer, STAFF (403) and an owner without a two-factor session are all refused. Nothing reaches Razorpay, and nothing is recorded.
  - ADMIN is refused above ₹10,000 (403 `over_limit`) and allowed at exactly ₹10,000. The rest of that payment is refunded by OWNER.
- **No storefront shortcut:** no shopper route exists, and no file in `app/`, `components/` or `lib/` calls a refund route.
- **Paid amount (CHV-S14-M16):**
  - **Full refund:** `succeeded` with Razorpay's refund id, and the payment `refunded`. Anything more is refused, and the staff approval is audited.
  - **Partial refunds:** they add up to exactly the paid amount, and one paisa more is refused with the remaining balance.
  - **Refunded on Razorpay's side:** a refund made outside our records counts against the balance.
  - **Bad input:** amounts that are zero, below ₹1, fractional, text or negative, and extra fields (a currency, a payment id), are each a 400.
  - **Not refundable:** an uncaptured payment is a 409, and an unknown or malformed attempt is a 404.
- **Once:**
  - The same key returns the same refund with no new Razorpay refund. The same key for another amount is a 409, and no key is a 428.
  - Five simultaneous full refunds (decisions forced to overlap) give one refund and four 409s.
  - A refund whose request never reached Razorpay stays under way and counts: another key cannot refund the same money, and its own key resumes it.
  - A lost answer is found by our key in the same request.
  - With the follow-up lookups lost too, it is a 502, and the retry with the same key adopts the refund. Never a second refund.
- **Status:**
  - A pending refund is `processing` until `refund.processed` (via the inbox) makes it `succeeded` and the payment partly refunded.
  - `refund.failed` makes it `failed` and frees its amount.
  - A refund webhook that disagrees with Razorpay's own record is not believed.
  - A refund Razorpay refuses is `failed` and refunds nothing.
- **Sandbox:** production is 404, and payments off is 503.

Command: `npm run build:api`, then `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/support/register.mjs --test tests/security/payments/refund.test.mjs`. Result: 17 of 17.

**Also run:**
- After `npm run build`, with `--test-concurrency=4`: 407 of 407 for:
  - all `tests/security/payments/*.test.mjs` and all `tests/security/orders/*.test.mjs`;
  - `tests/contracts/payment-adapter.test.mjs`;
  - all `tests/security/auth/*.test.mjs` (every admin route needs its permission);
  - `tests/e2e/checkout-gate.test.mjs` and `tests/e2e/payment-handoff.test.mjs`.
- `npm run api:openapi` 79 paths; `npm run typecheck` clean (API and worker); `npm run lint` 0 errors, the 2 existing warnings.

**Mutation checks** (each applied, tested, then restored; the restored code passes 17 of 17; log `stage-14-16-mutations.log`).
- The first run left four mutations uncaught. Two were real gaps in the tests:
  - "our refunds under way not counted" and "no lock" passed because the stand-in itself refused over-refunds, and the requests did not truly overlap;
  - "webhook trusted" passed because no event disagreed with Razorpay.
- A lenient stand-in, a test-only 0.3 s delay on refund inserts, and two added tests fixed this. All three mutations are now caught.

| Mutation | Tests failing |
|---|---|
| Route permission lowered to `orders.read` | 0 of 15: the approval policy still refuses STAFF (limit zero), a double guard |
| Approval limit ignored | 1 of 15 |
| Refund over the refundable balance allowed | 3 of 15 |
| Razorpay's own refunded amount ignored | 1 of 15 |
| Our refunds under way not counted | 2 of 17 (after the added test; 0 before) |
| No lock while deciding | 1 of 17 (after the overlap; 0 before) |
| A failed refund still counted (its amount never freed) | 1 of 15 |
| Uncaptured payments refundable | 0 of 15: an uncaptured payment has no Razorpay payment id and is still refused, a double guard |
| The same key accepted for another amount | 1 of 15 |
| Adapter does not look for its refund first | 1 of 15 |
| Adapter does not look after a lost answer | 1 of 15 |
| A pending refund marked succeeded | 1 of 15 |
| Payment never moved to refunded | 4 of 15 |
| Refund webhook trusted without asking Razorpay | 1 of 17 (after the added test; 0 before) |
| Route open in production | 1 of 15 |

**Not covered here:**
- No admin page: the route is the API, for a later admin screen.
- No real Razorpay refund is made.
- A pending refund whose webhook is lost is not polled: the 14.14 reconciliation job covers payments, not refunds.
- A refund does not change the order's status (cancelling or returning an order with a refund is the order and returns flows, a later stage).

**Defaults set here (owner to confirm at the Stage 14 gate):**

- **Approval limits:** ADMIN up to ₹10,000 per refund, OWNER without limit (decision 030, proposed; the threshold is the owner's call).
- **Refund speed:** Razorpay `normal` (not instant).
- **Reason:** 3 to 500 characters, kept on the refund and in the audit trail; the first 200 go to Razorpay's notes.
- **Refunds made on Razorpay's dashboard:** they count against what can be refunded here. They are not recorded as our refunds.

## 14.17 Payment failure and replay gate (CHV-S14-M17), 31 October 2026

**Status:** PASS (the Stage 14 gate). Success, failure, timeout, replay, wrong-amount and refund scenarios run together against one database, through the real paths:
- checkouts opened and orders cancelled through the web host's forwarder;
- Razorpay webhooks signed and delivered through it;
- the worker's inbox, reconciliation and expiry jobs;
- staff refunds on the admin route with a two-factor session.

After every scenario the whole shop is checked against the money, order and stock invariants. Every suite passes.

**The invariants** (checked after each of the 12 scenarios, across every order in the database):

- **Stock:**
  - the Stage 09 reconciliation finds nothing: every balance agrees with the ledger and the holds;
  - on-hand stock covers what is held and allocated;
  - nothing is negative.
- **Orders:**
  - a confirmed order has exactly one captured payment, for exactly its grand total, recorded from a verified provider event, with its stock allocated, one confirmation and one `order.paid`;
  - no other order has either, or any fulfilment;
  - a pending order holds its stock;
  - a cancelled order has released it and has no captured payment applied;
  - no order is paid twice.
- **Money:**
  - no payment is refunded past what was captured;
  - a payment's status (`captured`, `partially_refunded`, `refunded`) says exactly how much was refunded;
  - our succeeded refunds are exactly the refunds Razorpay processed for that payment.

**Test:** `tests/security/payments/gate.test.mjs`, 12 tests (log `stage-14-17-gate.log`). Razorpay is a stand-in that keeps its orders, payments and refunds and can lose answers.

- **Success:** paid by webhook, confirmed once, stock allocated.
- **Failure:**
  - two failed tries end nothing, and a retry on the same checkout confirms.
  - A shopper who gives up after a failed try cancels and gets the stock released.
  - With money still on its way at Razorpay, cancelling waits and the stock stays held.
- **Timeout:** Razorpay opens the order but the answer is lost. The checkout is still the one Razorpay order, and paying it confirms once.
- **Expiry:** a window that ends with no payment is held, reconciled to `expired` and cancelled, and the stock comes back.
- **Replay:**
  - the same webhook twice, three more events for the same payment, and three workers at once: confirmed once;
  - a missing webhook reconciled, then the late webhook, then the job again: confirmed once;
  - a worker that dies after confirming: the event runs again and changes nothing;
  - a payment on an old tab's checkout after the order was paid on a new one is never applied.
- **Wrong amount:** one paisa short by webhook, and ₹1 over found by the reconciliation job, both go to review with stock held. Never confirmed.
- **Refunds:**
  - partial, then one paisa too many refused;
  - five simultaneous refunds of the rest (decisions forced to overlap, stand-in not checking the balance) give one refund;
  - one more is refused.
  - A refund webhook delivered three times, and the refund retried with its key, change nothing.
- **Everything at once:** eight orders with mixed outcomes (paid, failed then paid, wrong amount, failed, missing webhook, nothing) have their events delivered twice in shuffled order. Three workers and the reconciliation job race. Each order ends where it should.

Command: `npm run build:api`, then `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/support/register.mjs --test tests/security/payments/gate.test.mjs`. Result: 12 of 12.

**Mutation checks** (each applied, tested, then restored; the restored code passes 12 of 12; log `stage-14-17-mutations.log`). Mutations across the whole payment path, against the gate alone. The first run left five uncaught.
- Two of them, refund balance and refund lock, passed because the stand-in itself refused over-refunds.
- One, closing without asking Razorpay, passed because the gate had no case with money in progress.
- A lenient stand-in for the refund race, a forced overlap, and a money-in-flight cancellation were added; those three are now caught.
- The other two are second guards: the 13.10 bridge's own amount check, and the order no longer being pending.

| Mutation | Gate tests failing | Also caught by |
|---|---|---|
| A wrong amount handed on as verified | 0 of 12: the 13.10 bridge still sends it to review (a double guard) | 14.11 |
| Inbox deduplication removed | 1 of 12 | 14.10 |
| Webhook acknowledged without keeping the event | 8 of 12 | 14.10 |
| Refund balance not checked | 3 of 12 (after the change; 0 before) | 14.16 |
| No lock while deciding a refund | 3 of 12 (after the change; 0 before) | 14.16 |
| A failed try ends the attempt | 2 of 12 | 14.13 |
| Closing does not ask Razorpay | 1 of 12 (after the added case; 0 before) | 14.13 |
| Quiet checkouts never reconciled | 3 of 12 | 14.14 |
| A captured payment captured again | 0 of 12: the order is no longer pending, so nothing is allocated or confirmed twice (a double guard) | 13.10 |
| `order.paid` written on every capture | 12 of 12 | 14.12 |

**The whole project** (log `stage-14-17-full-suite.log`):

| Check | Result |
|---|---|
| `npm run build:api` | passes |
| `npm run api:openapi` | 79 paths |
| `npm run build` (web) | passes |
| `npm run typecheck` | clean |
| `npm run lint` | 0 errors, the 2 existing warnings |
| `npm test` (unit) | 112 of 112 |
| `npm run test:db` | 61 of 61 |
| `npm run test:security` (one file at a time) | 746 of 746 |
| `npm run test:e2e` | 87 of 87, after one change below |

The first `test:e2e` run had 2 failures, in the Stage 10 and 11 gates (`catalogue-gate`, `cart-gate`), which pinned "no payment path exists":
- **Webhook path:** both now expect `/api/webhooks/razorpay` to answer 503 (payments off in that test), and list the four Stage 14 sandbox payment paths in the API.
- **Pay page link:** the Stage 10 gate also allows the pay page's link back to the review page.

Nothing else in them changed; the bag's checkout button is still pinned as disabled.

**Found and fixed during Stage 14** (recorded in each step):
- 14.10's inbox claimed on the host clock against database-stamped due times (fixed in 14.15).
- The local Postgres runs out of connections when about 30 test files run at once (14.12); the gate's suites run one file at a time.

## Owner decisions at the Stage 14 gate, 31 October 2026

Asked before the commit; every "Defaults set here" item in 14.02 to 14.16 was covered.

- **ADMIN refund limit: ₹5,000 per refund** (the default was ₹10,000). OWNER refunds without limit; STAFF cannot refund.
  - Changed `REFUND_LARGE_THRESHOLD_PAISE` in `apps/api/src/auth/policies.ts` to 500,000 paise, plus the refund route's description, the refund service's comment and the 14.16 test. The test now checks exactly ₹5,000 is allowed and one paisa more is `over_limit`.
  - Rerun: `tests/security/payments/refund.test.mjs`, `tests/security/admin/admin-api.test.mjs`, `tests/security/payments/gate.test.mjs` and `tests/contracts/payment-adapter.test.mjs`, 61 of 61. OpenAPI 79 paths; typecheck clean; lint the 2 existing warnings.
- **Review page button:** stays "Payment opens soon", disabled, until a later stage wires "Place order and pay" (no change).
- **Razorpay's window:** shows "Chaanavya" and "Order CHV-…". The buyer's phone and email are not prefilled (no change).
- **Everything else:** accepted as recorded under "Defaults set here" in 14.02 to 14.16 (no change). In particular:
  - live payments stay off until KYC, banking and tax are confirmed through a reviewed code change;
  - the retry, inbox and reconciliation timings stand;
  - failed tries keep the stock held until cancel or window end;
  - money in another currency, for another order, after cancelling or paid twice is kept for staff to refund;
  - the webhook address is `/api/webhooks/razorpay` on staging, for the five events.
