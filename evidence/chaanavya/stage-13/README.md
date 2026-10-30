# Stage 13 evidence: orders, stock and consistency

Started 27 October 2026, after the owner accepted the Stage 12 gate by having it committed and pushed (3c89a67, with follow-up 3766cb5 on the `upgrade` branch).

**Testing rule for this stage (owner, 27 October 2026):** test only at the end of the stage. Each micro-stage runs its own focused test (the CHV-S13-Mxx check) and its mutation checks. The wider suites (`npm test`, `test:db`, `test:security`, `test:e2e`, build, typecheck, lint) run once at the Stage 13 gate.

## 13.01 Define order identifiers and immutable snapshots (CHV-S13-M01), 27 October 2026

**Status:** PASS (focused test; wider suites at the Stage 13 gate). An order placed from a checked quote now carries everything it was sold on, and the database refuses any later edit of it.

**Existing order schema, confirmed**

- **Identifiers:** `order.id` is a UUID v7. `order.number` is `CHV-` plus a number from the `order_number_seq` sequence, which starts at 100001.
- **Line snapshot:** each `order_item` copies its SKU, product and variant titles, handle, photo, HSN, quantity, unit price, discount, tax and tax lines, line total and currency. Since Stage 08 the trigger `order_item_snapshot_immutable` has refused changes to all of these.
- **Order row:** it holds the email, delivery and billing address, totals and quote reference, but nothing stopped an update to its totals, email or address.
- **Not stored before this step:** each line's tax classification (profile, category, rate, supply, rounding), the tax basis, the delivery option and its GST, the quote's fingerprint, and the customer's name and phone as given at the contact step.

**What changed**

- **Migration** `20261028000000_order_snapshots`, with rollback:
  - New nullable columns on `order`: `customer_snapshot` (kind, email, name, phone), `tax_snapshot` (profile, approval, supply, seller and delivery states, prices include tax, rounding), `shipping_snapshot` (service, courier, mode, estimated days, fee, fee GST, total, test or live rates) and `quote_fingerprint`. New on `order_item`: `tax_classification`.
  - Checks:
    - `order_number_format` (`^CHV-[0-9]{6,}$`)
    - `order_quote_snapshots_complete`: an order with a quote fingerprint must carry a valid fingerprint, the quote reference and all three snapshots
    - shape checks for each snapshot, tied to the order's own columns: customer email = order email, delivery fee = `shipping_fee_paise`, tax setting = `prices_include_tax`
  - The line trigger now also freezes `tax_classification`.
  - New trigger `order_snapshot_immutable`: after placing, only `status`, `fulfilment_status` and `updated_at` change, plus account links. `user_id` may go from empty to an account (a guest claiming the order, Stage 07) and either link may be cleared when the account or guest session is deleted. Moving an order to another account or guest session is refused.
- **Contract** (`packages/contracts/src/modules/order.ts`, additive): `OrderItemSnapshotV1.taxClassification?`, the new `OrderSnapshotV1`, and `OrderV1.snapshot?`.
- **Snapshot builder** `apps/api/src/orders/snapshot.ts` (new, pure):
  - `orderSnapshotOf` and `orderCreateData` turn a checked quote, the contact step, the owner, the quote's fingerprint and the catalogue's handle and photo per variant into the order row and its lines.
  - Every amount is the quote's; nothing is re-priced, and values are copied, not shared with the quote object.
  - It refuses a missing fingerprint, a line with no catalogue facts, an empty quote, or lines taxed by two profiles.
  - Placing orders (reserving stock and taking the submit key) is a later step; this only defines what an order stores.
- **Schema:** `apps/api/prisma/schema.prisma` gains the five fields, edited by hand so the file keeps its CRLF endings and existing alignment. The dev database has the migration applied.
- **Earlier orders:** orders created before this change (Stage 04 fixtures, any Shopify imports) keep empty snapshots; only orders placed from a quote must have them.

**Test:** `tests/security/orders/snapshot.test.mjs`, 12 tests. Each quote comes from the real API through the web host's forwarder (log `stage-13-01-order-snapshots.log`).

- **Identifiers:** a UUID v7 id and a `CHV-` number from one rising sequence.
- **Copied from the quote:** totals, quote reference, fingerprint, promotion, lower-cased email, delivery address, customer snapshot, tax basis, delivery snapshot (`ratesMode: "test"` for sandbox rates), and every line field including its tax classification.
- **A copy, not shared:** changing the quote object after building changes nothing in the snapshot.
- **Later edits (CHV-S13-M01):** after the order was placed, these all changed: price, variant and product titles, SKU, handle, photo, weight, shipping restriction, the tax rate and HSN, the promotion's percentage, and the bag's contact and address. Nothing the order was sold on moved. Archiving the variant changes nothing; deleting it clears only the line's link.
- **Database refusals:**
  - on the order: total, fee, email, address, customer, tax basis, delivery, fingerprint, quote, number, submit key and placed time
  - on a line: price, quantity, tax lines, tax classification and title
- **What may still change:** status and fulfilment can change. A guest can claim the order, but moving it to another account is refused. Deleting the account clears its link, and attaching another guest session is refused.
- **Required snapshots:** an order from a quote is refused if any snapshot is missing or disagrees with its own columns, or if the fingerprint or number is malformed.
- **Replays:** the same submit key never makes a second order.
- **Builder refusals:** the builder refuses what it can't copy faithfully, and a signed-in customer's order is recorded as a customer's.

Command: `npm run build:api`, then `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/support/register.mjs --test tests/security/orders/snapshot.test.mjs`. Result: 12 of 12.

**Test mistakes found by the first run and fixed:**

- Lines inserted together share a timestamp, so they are now matched by variant.
- A variant still in a bag can't be deleted, so the bag is emptied first.
- I had used a fulfilment value that doesn't exist; it is now `packing`.

**Mutation checks** (each undone; restored 12 of 12):

| Mutation | Tests failing |
|---|---|
| Order row not frozen (no trigger) | 2 |
| An order may move to another account | 1 |
| A line's tax classification not frozen | 1 |
| A quote order without snapshots allowed | 1 |
| The delivery snapshot may disagree with the fee | 1 |
| The snapshot shares the quote's objects | 1 |
| Lines without catalogue facts accepted | 1 |
| Test delivery rates recorded as live | 1 |

**Not run here (per the testing rule):** the wider suites. A run was started and stopped when the owner set the rule; its partial output isn't used. The schema-drift check (`test:db`) and every test that creates orders will run at the Stage 13 gate.

**Not decided here:**

- the billing address (not collected at checkout, so it stays empty)
- whether an order placed with test delivery rates or a draft tax profile should be refused outright when orders are placed (13.0x)

## 13.02 Create idempotent order-intent endpoint (CHV-S13-M02), 27 October 2026

**Status:** PASS (focused test; wider suites at the Stage 13 gate). A checked quote now becomes exactly one pending order. A duplicate submission, by key, by quote or in parallel, returns the original order.

**What changed**

- **Order intent** `apps/api/src/orders/intent.ts` (new):
  - **Request:** the shopper's own quote id, the grand total they were shown, and an `Idempotency-Key` header (8 to 100 letters, digits, `-` or `_`). Nothing else in the body is read.
  - **Repeats:**
    - The same key, or the same quote under a new key (a double click after a reload), returns the original order (200, `replayed: true`), answered before anything is checked again.
    - A key reused for another quote is 409 (`Idempotency-Key: reused`).
    - Keys are stored as a digest of the shopper and the key, so two shoppers' identical keys never collide and the raw key is never stored.
  - **Checks for a new order:**
    - the quote check from 12.10 (owner, expiry, fingerprint, stock)
    - the shown total must equal the quote's; otherwise 409 with `expectedGrandTotal: amount_mismatch`, nothing is created, and the quote stays usable
    - the contact step and catalogue facts are read
  - **Placing:** in one transaction, the owner and then the bag are locked, the request is checked again, and the bag must still be at the quoted revision. The 13.01 snapshot is written and the quote is used up.
  - **Parallel submissions:** a parallel submission that loses on the key or quote unique index is answered with the winner's order.
- **Route** `POST /api/v1/cart/order` (`apps/api/src/modules/order-intent.controller.ts`): shopper access, no-store, 10 calls a minute. It answers 201 for a new order and 200 for a replay, and is registered before the cart controller. OpenAPI now has 65 paths.
- **Contract** `PlacedOrderV1` (`packages/contracts/src/modules/order.ts`): id, number, status, quote, grand total, `test` flag, lines and placed time.
- **Migration** `20261028010000_order_one_per_quote`, with rollback: a partial unique index, so one quote can never make two orders. It is noted on the model in `schema.prisma`, because Prisma doesn't model partial indexes. The dev database has it applied.
- **Stage 12 gate test** (`tests/e2e/checkout-gate.test.mjs`): the "orders can only be read" check now also allows `/api/v1/cart/order`. Every payment, checkout, confirm and webhook path stays refused. This check runs at the Stage 13 gate.

**Defaults set here (owner to confirm):**

- **Where it's open:** development and staging only until payments exist, the same as your review-page decision; production answers 404.
- **Test quotes:** a test quote (sandbox rates or a draft tax profile) can never become an order in production. This is defense in depth, since production is closed anyway.
- **Duplicates:** a duplicate is the same key or the same quote, and both return the original order.
- **Not handled here:** stock is not reserved (13.03), and the bag isn't emptied until payment (later stages). A shopper who asks for a new quote for the same bag can place a second order.

**Test:** `tests/security/orders/intent.test.mjs`, 13 tests, through the web host's forwarder (log `stage-13-02-order-intent.log`):

- **First order:** a pending order copied from the quote, with its fingerprint stored, the quote used up, no reservation and no payment.
- **Same key:** three repeats give the identical order as replays.
- **Same quote, new key:** the same order.
- **Replay after changes:** a replay still returns the order after the price and stock change.
- **Parallel:** 8 parallel submissions with one key, and 8 with different keys: one 201, all answered with the same order, exactly one order.
- **Key reuse:** a key reused for a new quote is refused, and another shopper with the identical key gets their own order.
- **Not the owner:** another shopper's quote, an unknown quote or no session places nothing.
- **Wrong total:** refused (`amount_mismatch`), the quote stays usable, and a replay is checked against the order's total too.
- **Tampering:** prices, totals, items and status in the body are ignored.
- **Stale quotes:** a bag changed after quoting, or an expired quote, places nothing.
- **Bad requests:** a missing key (428), a malformed key or a malformed body (400).
- **Production:** 404, and nothing placed.
- **Stored keys:** they are per-shopper digests.

Command: `npm run build:api`, then `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/support/register.mjs --test tests/security/orders/intent.test.mjs`. Result: 13 of 13, on the first run.

**Mutation checks** (each undone; restored 13 of 13):

| Mutation | Tests failing |
|---|---|
| No replay by key | 2 |
| No replay by quote | 2 |
| Shown total not compared | 1 |
| Keys not scoped to the shopper | 1 |
| Quote not used up | 1 |
| Open in production | 1 |
| No owner lock (the index and the re-check remain) | 1 |
| No one-order-per-quote index (the lock and the re-check remain) | 0: covered by the other two |
| No revision re-check inside the lock (the quote check remains) | 0: covered by the quote check |
| No owner lock **and** no index | 1: duplicates get through, so the layers matter |

**Not run here (per the testing rule):** the wider suites, including the Stage 12 gate test changed above.

## 13.03 Bind pending order to checkout session (CHV-S13-M03), 28 October 2026

**Status:** PASS (focused test; wider suites and mutation checks at the Stage 13 gate). A pending order is now bound to the shopper, the bag it came from and its quote's payment window, and nobody else can use its id.

**What changed**

- **Migration** `20261028020000_order_checkout_binding`, with rollback:
  - adds `order.cart_id` (foreign key to the bag, cleared if the bag is deleted) and `order.payable_until` (the quote's expiry)
  - an order from a quote must have a payment window, and the window ends after the order was placed
  - the 13.01 order trigger now also freezes `payable_until`, and the bag link may only be cleared, never moved
  - the dev database has it applied
- **Snapshot builder** (`apps/api/src/orders/snapshot.ts`): an order placed from a quote links its bag and takes the quote's expiry as its payment window.
- **Pending order lookup** `apps/api/src/orders/checkout-session.ts` (new): `pendingOrderFor(owner, orderId)`.
  - **Owner:** the order's own guest session or customer is part of the database lookup itself, so a foreign order is never read. Another guest, a customer, a signed-out visitor, an unknown id and a malformed id all get the identical 404.
  - **Status:** only a `pending_payment` order can be continued (409 `not_pending` otherwise).
  - **Window:** at or after `payable_until`, 409 `expired`, and the shopper asks for a new quote.
  - **Bag:** the bag it came from must still be the shopper's and live. A bag that was merged away, expired or was deleted gives 409 `checkout_ended`.
- **Route** `GET /api/v1/cart/order/{orderId}` (on the order-intent controller): shopper access, no-store, 30 calls a minute, 404 in production. OpenAPI was regenerated.
- **Contract:** `PlacedOrderV1.payableUntil`.

**Defaults set here (owner to confirm):**

- **Payment window:** an order's price is payable for the quote's 15 minutes.
- **Guest orders after sign-in:** a guest's order stays with the guest session that placed it. After signing in, the customer can't continue it unless it is claimed (the Stage 07 claim).

**Test:** `tests/security/orders/checkout-session.test.mjs`, 11 tests, through the web host's forwarder (log `stage-13-03-checkout-session.log`):

- **Binding:** a placed order names its bag, and its payment window is the quote's expiry.
- **Owner:** the shopper who placed it can continue it.
- **Foreign id (CHV-S13-M03):**
  - another guest, a signed-in customer and a signed-out visitor all get exactly the 404 an unknown id gets
  - malformed ids, an SQL-looking id and the order number get 404
- **Foreign quote:** someone else's quote can't be placed or moved under a stranger.
- **Sign-in:** a guest's order isn't the signed-in customer's to continue.
- **Customers:** a customer's order is refused to another customer and to a signed-out visitor.
- **Window:** payable 1 ms before the window ends, refused at the end.
- **Status:** a cancelled order can't be continued.
- **Bag gone:** a deleted bag clears only the link and ends the checkout.
- **Frozen:** the bag link and the window can't be moved or extended, and a quote order without a window is refused.
- **Production:** the route is closed.

Command: `npm run build:api`, then `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/support/register.mjs --test tests/security/orders/checkout-session.test.mjs`. Result: 11 of 11.

**Interrupted mutation run:**

- **What happened:** a mutation run was started, against the testing rule, and stopped by the owner.
- **What it left behind:** one mutation (the window boundary, `<=` changed to `<`) was left applied. It was found and restored, every other target was checked to be unchanged, the API was rebuilt, and the focused test was run again on the restored code (11 of 11).
- **From here on:** mutation checks run at the Stage 13 gate only.

## 13.04 Integrate existing Stage 09 reservation API (CHV-S13-M04), 28 October 2026

**Status:** PASS (focused test; wider suites at the Stage 13 gate). Placing an order now holds its stock through the Stage 09 reservation code, in the same transaction as the order.

**What changed**

- **Stage 09 reservations** (`apps/api/src/inventory/reservations.ts`):
  - **The split:** the body of `reserveStock` is now `reserveWithin(tx, input)`, so a caller can run it inside its own transaction. The request checks moved into a shared `reserveLines`.
  - **The same steps as before:** one line per variant in id order, so locks never deadlock; key replay and reuse; pending-order check; sellable check; one `reservation` movement per line through `applyMovement`.
  - **`reserveStock` is unchanged from outside:** its interface, results and error handling are the same, and it is now `reserveWithin` in its own transaction.
  - **Nothing new in the ledger:** no new stock arithmetic and no second ledger.
- **Order intent** (`apps/api/src/orders/intent.ts`):
  - **Same transaction:** after writing the order, the same transaction calls `reserveWithin` with the quote's lines and the key `order:<order id>`.
  - **Hold length:** the order's payment window (`payable_until`), kept within the Stage 09 limits of 60 seconds to 30 minutes.
  - **A failed hold rolls everything back:** not enough stock, an unsellable item, or any other refused hold rolls back the order with it, and the quote isn't used up. The answer is 409 naming the variants (`insufficient_stock`, `not_sellable` and so on).
  - **Transaction time:** the transaction uses Stage 09's time limits (wait 10 s, run 15 s).
  - **No stock code of its own:** the order code reads or writes no stock balance or ledger row itself.
- **13.02 test** (`tests/security/orders/intent.test.mjs`): its "no stock reserved here" check now expects the order's one hold.

**Test:** `tests/security/orders/reservation.test.mjs`, 8 tests, through the web host's forwarder (log `stage-13-04-reservation.log`):

- **One hold (CHV-S13-M04):** placing an order makes one active reservation, keyed `order:<id>`, with every line, lasting the payment window. Each line has exactly the Stage 09 `reservation` movement (`reserve:<hold>:<variant>`); reserved rises by the quantity, and on hand and allocated don't move.
- **Repeats:** a replay, or the same quote under a new key, never holds twice: one reservation, one movement.
- **Parallel:** 6 parallel submissions of one quote hold the stock once.
- **Last unit:** two shoppers race for it. One order holds it; the other is refused, its order is rolled back, and the unit is never oversold.
- **Hold fails after the order row is written:** stock is taken just after the quote check. The order is rolled back with the failed hold, nothing is reserved or moved, and the quote is still there.
- **Hold length:** with ten seconds of the window left, the hold uses the Stage 09 minimum.
- **Stage 09 behaviour kept:** `reserveStock` still holds, replays by key and refuses a reused key.
- **No separate stock code:** the order code only calls `reserveWithin` and touches no balance or movement directly, and `reserveStock` is `reserveWithin` in its own transaction.

Command: `npm run build:api`, then `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/support/register.mjs --test --test-concurrency=1 tests/security/orders/reservation.test.mjs tests/security/orders/intent.test.mjs`. Result: 21 of 21 (8 new, 13 from 13.02).

**Test mistake found by the first run and fixed:** the ledger's time field is `occurredAt`, not `createdAt`.

**For the Stage 13 gate:** Stage 09 reservation code was refactored, so its own suites (`tests/integration/database/inventory.test.mjs`, `tests/security/inventory/inventory.test.mjs`) and the mutation checks run there.

**Defaults set here (owner to confirm):**

- **Hold length:** the hold lasts the payment window, at least 60 seconds.
- **Out of stock:** an order is refused, never placed short, when any line can't be held.
- **Not handled here:** releasing expired holds (the Stage 09 worker already does) and allocating on payment are later steps.

## 13.05 Implement atomic multi-item checkout reservation (CHV-S13-M05), 29 October 2026

**Status:** PASS (focused test; wider suites and mutation checks at the Stage 13 gate). Placing an order holds every line of the bag or none. Simultaneous checkouts for the last unit give exactly one reservation.

**How all-or-none is guaranteed (already in place, confirmed here):**

- **Each line:** a line's stock moves through one conditional `UPDATE` on its stock row (Stage 09 `applyMovement`). It only succeeds while enough stock is free, and it locks that row until the transaction ends.
- **Lock order:** lines are locked in variant-id order (`reserveWithin`), so two bags holding the same items in opposite order wait for each other instead of deadlocking.
- **One transaction:** since 13.04, the order, every line's hold and its ledger movement are in one transaction. A shortfall on any line throws and rolls everything back.
- **No code change was needed for this step.** This step adds the proof under real races.

**Test:** `tests/security/orders/atomic-reservation.test.mjs`, 5 tests. Every shopper is quoted while the stock is still free, then all of them place their order at the same moment through the web host's forwarder (log `stage-13-05-atomic-reservation.log`).

- **Ten shoppers, last unit (CHV-S13-M05):** exactly one order and one reservation; nine are refused.
- **Last unit plus a plentiful item:** six shoppers each want both. One wins, and the plentiful item's reserved count is only the winner's 3, so no loser kept a partial hold.
- **Scarce item first for some, second for others:** stock a = 2, b = 1, six shoppers. One wins, and a's reserved count is 1, not 2.
- **Opposite-order bags, three rounds:** four shoppers per round, two adding x then y and two adding y then x, one unit each. Every round finished well inside the limits with one winner.
- **Refused checkouts:** they leave no order, no hold and no movement, and each refusal names the stock problem.
- **Checked after every race:**
  - reserved stock equals exactly what the active holds cover
  - nothing is oversold
  - there is one reservation movement per held line
  - there is no order from a quote without its hold
  - every answer was an order (201) or a refusal (409), never an error

Command: `npm run build:api`, then `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/support/register.mjs --test tests/security/orders/atomic-reservation.test.mjs`. Result: 5 of 5, and 5 of 5 on two further runs.

**Test mistake found by the first run and fixed:** the opposite-order test sent each shopper's checkout twice. The second was correctly a replay (200, the same order), so the test now uses four different shoppers.

**Environment:** Docker Desktop wasn't running, so it was started, and the project database came up healthy on port 15432.

## 13.06 Enforce order state transition rules (CHV-S13-M06), 29 October 2026

**Status:** PASS (focused test; wider suites and mutation checks at the Stage 13 gate). An order and its fulfilment can only move along their state machines, only when the right actor asks, and the database refuses any other move.

**Before this step:** the order and fulfilment state machines existed in the contract, and `transitionOrder` checked their guards. But the database accepted any status, so a direct write could jump an order from pending to shipped. Nothing tied who was acting to the moves they may make, the guards trusted a caller-supplied `source`, and fulfilment had no checked transition at all.

**What changed**

- **Contract** (`packages/contracts/src/modules/state-machines.ts`): `ORDER_TRANSITION_ACTORS` and `FULFILMENT_TRANSITION_ACTORS` list who may ask for each move, and `actorMayTransition` checks it.

  | Move | Allowed actors |
  |---|---|
  | Payment outcome: pending to confirmed, needs review or cancelled | provider, system |
  | Resolving a review | staff |
  | Cancelling a confirmed order before dispatch | customer, guest, staff |
  | Completing | provider, system |
  | Packing and packed | staff |
  | Handed over to the courier | provider |
  | Fulfilment cancelled | staff, system |

  - `sourceOf` maps the actor to the guard's fact source (a guest acts as a customer).
  - The audit action list gains `order.fulfilment_transition`.
- **Transitions** (`apps/api/src/db/transitions.ts`):
  - **Order:** `transitionOrder` now locks the order row first and takes the order and fulfilment status from it, never from the caller. It refuses an actor not allowed for the move (`actor_not_allowed`) and binds the guard's `source` to the real actor. Then it plans, compare-and-sets and audits as before.
  - **Fulfilment:** new `transitionFulfilment`, the same pattern for packing, packed, handed over and cancelled.
  - **Repeats:** asking for the state the order is already in is a no-op and writes nothing.
  - **Stale requests:** a stale "from" is refused as a concurrent update.
- **Migration** `20261029000000_order_transitions`, with rollback: the trigger `order_transitions_only` allows only the machines' moves for `status` and `fulfilment_status`.
  - Fulfilment may start (packing, packed, handed over) only for a confirmed order, so there's no unpaid shipping.
  - An order is completed only after it was handed over.
  - New rows aren't checked: orders are created pending, and earlier fixtures and imports may be inserted in any state.
  - The dev database has it applied.
- **13.01 test** (`tests/security/orders/snapshot.test.mjs`):
  - **Fulfilment move:** it now moves a cancelled order's fulfilment to cancelled instead of packing, which this step correctly refuses.
  - **Quote reference:** two of its tests gave a second order the same quote reference, which the 13.02 one-order-per-quote rule correctly refuses. They now use their own reference. This first showed here, because the 13.01 tests weren't rerun after 13.02.

**Test:** `tests/security/orders/transitions.test.mjs`, 13 tests (log `stage-13-06-transitions.log`):

- **Pending to shipped (CHV-S13-M06):** a pending order can't be handed to the courier, packed or completed, either through the API (no such move, or the "order not confirmed" guard) or by a direct database write. The order stays pending and unfulfilled.
- **The full path:** pending, confirmed (provider), packing, packed (staff), handed over (provider), completed (system), with one audit row per move naming the actor and the rule met.
- **Completion:** completing needs a handed-over order, read from the row.
- **Every move against the database:** every order status pair and every fulfilment pair (on a confirmed order) is allowed by the database if and only if it is a transition of its machine. Every transition has its actors listed, and every listed move is a transition.
- **Actors:**
  - a customer, guest or staff can't confirm a payment, even claiming to be the provider
  - only staff resolve a review
  - the customer or guest may cancel before dispatch, but a system job can't, and after handover nobody can
  - only the courier hands a parcel over, and only staff pack
- **Faked facts:** claiming "the order is confirmed" changes nothing, because the row decides.
- **Repeats and races:** a repeat is a no-op with no audit row, a stale "from" is refused, and of two simultaneous moves from the same state exactly one applies.

Command: `npm run build:api`, then `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/support/register.mjs --test --test-concurrency=1 tests/security/orders/transitions.test.mjs tests/security/orders/snapshot.test.mjs`. Result: 25 of 25 (13 new, 12 from 13.01).

**For the Stage 13 gate:** `transitionOrder` changed, and its callers are the Stage 04 transaction tests and Stage 09's late-capture path (acting as `system`, which is allowed). Those suites and the mutation checks run there.

**Defaults set here (owner to confirm):** the actor table above. In particular, customers and guests may cancel a confirmed order themselves before dispatch (with a refund requested), and only staff may resolve an order under review.

## 13.07 Separate financial and fulfilment state (CHV-S13-M07), 29 October 2026

**Status:** PASS (focused test; wider suites and mutation checks at the Stage 13 gate). Payment and fulfilment now move independently, by different actors, and no payment callback can mark an order shipped.

**Before this step:** fulfilment was already stored apart from payment: fulfilment on the order, payment status on its own `payment_attempt` rows. But 13.06 used one "provider" actor for both the payment provider and the courier, so a payment callback was allowed to hand a parcel over. Payment attempts had a state machine but no checked transition and no database rule.

**What changed**

- **Contract** (`packages/contracts/src/modules/state-machines.ts`):
  - **Two actors:** the provider actor is split into `payment_provider` and `courier`. `actorClassOf` tells them apart by the provider's name (Razorpay and PhonePe are payment; Shiprocket and the sandbox courier are courier). An unknown provider has no class and may make no move.
  - **Who moves what:**
    - payment outcomes on the order: payment provider or a system job
    - completing an order: courier or a system job
    - handing over: courier only
    - payment attempts (`PAYMENT_TRANSITION_ACTORS`, from the payment machine itself): the payment provider, or a system job only for the moves the machine gives it (expiry, an unknown outcome)
  - **Audit:** the audit action list gains `payment.transition`.
- **Transitions** (`apps/api/src/db/transitions.ts`):
  - order and fulfilment moves check the actor's class
  - the new `transitionPayment` locks the attempt, checks the actor, and refuses an event from another provider than the attempt's own (`provider_mismatch`); then it plans, compare-and-sets and audits
  - it touches only the payment attempt: the order's status follows separately through `transitionOrder`, and fulfilment never follows a payment
- **Migration** `20261029010000_payment_transitions`, with rollback:
  - `payment_transitions_only`: a payment attempt's status moves only along the payment machine
  - `order_status_and_fulfilment_apart`: an order's status and its fulfilment can't change in the same write, so no single event confirms and ships
  - the dev database has it applied
- **13.06 test** (`tests/security/orders/transitions.test.mjs`): its "provider" actor is now a payment provider for payment moves and a courier for handovers.

**Test:** `tests/security/orders/payment-fulfilment.test.mjs`, 10 tests (log `stage-13-07-payment-fulfilment.log`):

- **A full payment callback (CHV-S13-M07):** the payment is captured and the order confirmed, and fulfilment stays "unfulfilled".
- **Payment provider and fulfilment:** the payment provider can't pack, hand over or complete an order, even claiming an AWB or delivery.
- **One write:** a single write can't both confirm an order and move its fulfilment.
- **The real path:** a captured payment, then confirmed (payment provider), packing and packed (staff), handed over (courier). The audit trail names each actor.
- **Payment actors:** a courier, staff, a customer, or a system job can't capture a payment; a system job may only record an unknown outcome.
- **Wrong provider:** another provider's event, an unknown provider or an unnamed provider moves nothing.
- **Courier and payment:** a courier can't confirm payment for an order.
- **Every move against the database:** every payment status pair is allowed by the database if and only if it is a transition of the payment machine, and the actor table covers each one.
- **Repeats:** the same callback twice changes nothing more.
- **Actor classes:** worked out from kind and provider name.

Command: `npm run build:api`, then `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/support/register.mjs --test --test-concurrency=1 tests/security/orders/payment-fulfilment.test.mjs tests/security/orders/transitions.test.mjs`. Result: 23 of 23 (10 new, 13 from 13.06).

**Defaults set here (owner to confirm):** the provider names are Razorpay and PhonePe for payments, and Shiprocket and the sandbox courier for delivery. A new provider must be added to that list before its events can move anything.

## 13.08 Create order event and audit trail (CHV-S13-M08), 29 October 2026

**Status:** PASS (focused test; wider suites and mutation checks at the Stage 13 gate). Every sensitive change to an order leaves one append-only event naming its origin, and the database refuses a change that has none.

**Before this step:** the transition functions wrote `audit_event` rows, but placing an order wrote none. A direct database write could change any status without leaving a trace or naming who did it. And there was no single timeline for an order.

**What changed**

- **Migration** `20261029020000_order_events`, with rollback:
  - **The table:** a new `order_event`, one timeline per order. Each event has its kind (placed, status, fulfilment, payment, reservation), the order, payment attempt or hold that moved, from and to, actor kind and id, correlation id, the rule met, a context and the time.
  - **Append-only:** updates, deletes and truncation are refused, using the same guard as the audit trail and the stock ledger.
  - **Placement recorded once:** a unique index (`order_event_placed_once`).
  - **Redaction enforced:** the context must be an object without email, name, phone, address, PIN, submit or idempotency key, guest session, token, cookie, OTP or password keys.
  - **Moves recorded by the database:** `AFTER UPDATE` triggers on the order (status and fulfilment), payment attempts and stock holds write each move into the trail themselves. The origin comes from the transaction's declared `chaanavya.origin`, and if there is none (or it lacks an actor or correlation id) the change is refused: `no auditable origin`.
  - The dev database has it applied.
- **Origin** `apps/api/src/db/origin.ts` (new): `declareOrigin(tx, origin)` sets a transaction-local origin (actor kind and id, correlation id, rule) that ends with the transaction.
  - It is called by `transitionOrder`, `transitionFulfilment`, `transitionPayment` (`apps/api/src/db/transitions.ts`) and Stage 09's `transitionReservation`, acting as a system job. These are the only code paths that change these statuses.
  - The `audit_event` rows they already wrote stay as they are.
- **Placement** (`apps/api/src/orders/intent.ts`, controller): inside the order transaction, placing an order declares its origin and writes the `placed` event.
  - **Actor:** the guest (no id) or the customer (account id).
  - **Correlation id:** the request's own, passed by the route.
  - **Context:** order number, quote, grand total in paise, line count, stock hold, and whether it is a test order.
- **Test helper** `withOrigin(db, fn)` in `tests/security/auth/helpers.mjs`. The 13.01, 13.03, 13.06 and 13.07 tests use it where they set a status directly.

**Test:** `tests/security/orders/events.test.mjs`, 11 tests, through the web host's forwarder (log `stage-13-08-order-events.log`):

- **Placement:** one `placed` event with the guest, the request's own `x-correlation-id`, and a context of only the number, quote, total, line count, hold and test flag. The shopper's email, name, phone, address, landmark, PIN, submit key and guest session appear nowhere in the trail.
- **Customer placement:** names the customer's account id and never the email.
- **The full path (CHV-S13-M08):** payment captured (Razorpay), hold allocated (system), order confirmed (Razorpay), packing and packed (staff), handed over (Shiprocket). Each move is recorded once, with its actor, its own correlation id and the rule met.
- **Current state:** the trail explains it, since each event starts where the last ended.
- **No origin:** a direct status change without one is refused for orders, payments and holds, including raw SQL, and nothing changes. An origin without an actor or correlation id doesn't count, and an origin never outlives its transaction.
- **Protection:** the trail can't be edited or deleted, and refuses personal keys in its context.
- **Repeats and races:** replays by key or quote, and 6 parallel submissions, leave exactly one placement. A repeated move is a no-op with no event, and the database refuses a second placement event.

Command: `npm run build:api`, then `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/support/register.mjs --test --test-concurrency=1 tests/security/orders/events.test.mjs tests/security/orders/snapshot.test.mjs tests/security/orders/checkout-session.test.mjs tests/security/orders/transitions.test.mjs tests/security/orders/payment-fulfilment.test.mjs`. Result: 57 of 57 (11 new, 46 from 13.01, 13.03, 13.06 and 13.07).

**For the Stage 13 gate:** every status change now needs a declared origin, so any test or job that changes a status directly will be refused. Stage 09's worker paths go through `transitionReservation`, which declares one. The Stage 04 and 09 suites, the remaining order tests and the mutation checks run there.

## 13.09 Implement safe order cancellation before payment (CHV-S13-M09), 29 October 2026

**Status:** PASS (focused test; wider suites and mutation checks at the Stage 13 gate). An unpaid order is now cancelled when its payment window ends or when its shopper cancels, and its stock is released exactly once. An order whose payment is still in flight is left waiting.

**Before this step:**

- **Holds released, orders not:** the Stage 09 expiry job released a hold when it expired, but nothing cancelled the unpaid order, which stayed `pending_payment` for good.
- **No cancelling an unstarted payment:** the order machine's cancel rule needed a payment that had closed, so an order whose shopper never started paying (the usual abandoned checkout) couldn't be cancelled at all.

**What changed**

- **Contract** (`packages/contracts/src/modules/state-machines.ts`):
  - **New facts:** `paymentStarted` and `cancelRequested`.
  - **Order cancel rule:** pending to cancelled is allowed when no payment was started, or the payment closed without a capture; the hold must still be released first.
  - **Hold release rule:** a hold may also be released when the shopper cancels before paying.
  - **Actors:** the customer and the guest may now cancel their own unpaid order, alongside the payment provider and system jobs.
- **Cancellation** `apps/api/src/orders/cancel.ts` (new): `cancelUnpaidOrder` runs in one transaction.
  - **Order of steps:** it locks the order, checks it is still pending, releases the hold through Stage 09's `transitionReservation`, then cancels the order through `transitionOrder`. Both are compare-and-set, and the release's ledger entries use one key per hold line, so it can release only once.
  - **Payment in flight:** while any payment attempt is open (created, authorized, being reconciled) the outcome is unknown, so the order and its stock wait (`awaiting_payment_outcome`). An attempt still "created" when the window ends is marked `pending_reconciliation`, the machine's system move, so the gateway is asked (13.14) before anything is released.
  - **Captured payment:** never cancelled here (13.10 and 13.11 handle it).
  - **Shopper path:** `shopperCancelsOrder` does the owner-checked shopper version.
- **Route** `POST /api/v1/cart/order/{orderId}/cancel` (order-intent controller):
  - shopper access, no-store, 10 calls a minute, closed in production
  - another shopper's order, an unknown id or a malformed id is 404; an order no longer pending is 409
  - a repeat answers `noop`
  - OpenAPI now has 67 paths, and the Stage 12 gate test's order-write list includes the route
- **Worker job** `apps/worker/src/jobs/order-expiry.ts` (new, registered in `apps/worker/src/main.ts`, lock 7013):
  - every minute it cancels unpaid quote orders whose payment window has ended, each in its own transaction
  - it takes an optional clock, so tests can run it as if time has passed
  - the API package exports `./orders/*` for it

**Test:** `tests/security/orders/cancel.test.mjs`, 12 tests, through the web host's forwarder (log `stage-13-09-cancel.log`):

- **Shopper cancels:** the hold is released (one release movement per line, reserved back to 0), the order cancelled, and the trail reads placed (guest), hold released (system), cancelled (guest).
- **Repeat cancels:** no second release and no second event.
- **Eight parallel cancels (CHV-S13-M09):** one cancels, all succeed, and the stock is released once.
- **Job racing the shopper:** two expiry calls and two shopper cancels at the same moment, then two job runs, release once.
- **The real job:** run as if the window has passed, three overlapping runs cancel the due order once, recorded as `system` with the job's correlation id. An order still inside its window is left alone.
- **Payment in flight:**
  - an open "created" payment past the window is sent for reconciliation, and the order and its stock wait, run after run
  - an authorized or reconciling payment keeps the order, and the shopper can't cancel it away either
  - a failed or expired payment no longer holds the order back
  - a captured payment is never cancelled here
- **Ownership:** another shopper, an unknown or malformed id, or no session gets 404 and nothing is released. A confirmed order can't be cancelled through this route, and the route is closed in production.

Command: `npm run build:api`, then `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/support/register.mjs --test tests/security/orders/cancel.test.mjs`. Result: 12 of 12, twice.

**Defaults set here (owner to confirm):**

- **Shopper cancelling:** a customer or guest may cancel their own unpaid order.
- **Payment in flight:** an order with a payment still in flight is never cancelled or released until the payment's outcome is known.
- **Stuck "created" attempt:** one still "created" when the window ends is marked for reconciliation.

## 13.10 Build the captured-payment allocation bridge (CHV-S13-M10), 30 October 2026

**Status:** PASS (focused test; wider suites and mutation checks at the Stage 13 gate). An authoritative capture from a payment provider now allocates the order's held stock and confirms the order, exactly once, however often or concurrently the capture arrives.

**Before this step:** nothing turned a captured payment into allocated stock and a confirmed order. The hold stayed reserved and the order stayed `pending_payment` until the hold expired.

**What changed**

- **Bridge** `apps/api/src/orders/capture.ts` (new): `applyCapture(db, { paymentAttemptId, event, capturedAmountPaise, currency, providerPaymentId?, correlationId })` runs in one transaction.
  - **Who may report:** only a payment provider (`actorClassOf`), and only the attempt's own provider; anything else is refused (403 or 409). A negative or fractional amount is refused (400).
  - **Order of steps:** it locks the payment attempt (concurrent events for one payment queue there), records the event once in `provider_event`, records the captured amount, moves the attempt to `captured` (`transitionPayment`), settles the hold with Stage 09's `settleReservation`, then moves the order `pending_payment` to `confirmed` (`transitionOrder`). Every move names the provider and the request (Stage 13.08 origins). Fulfilment never moves here.
  - **Events:** the same provider event id with the same body is a `duplicate` and changes nothing; the same id with a different body is a `conflict` and is never applied. A new event for a payment already captured is `already_applied`.
  - **Amount check:** the Stage 09 settlement requires the captured amount to equal the order's grand total in INR. A different amount sends the order to `needs_review` and keeps the stock held for staff; nothing is allocated or released.
  - **Late capture:** a hold already released before the money arrived sends the order to `needs_review` (outcome `late`); Stage 13.11 decides those.
  - **Closed attempts:** a failed, expired or refunded attempt is never captured here; the event is stored as a conflict for reconciliation (13.14).
- **No new route:** verifying provider webhooks and calling this bridge is Stage 14's adapter work.

**Test:** `tests/security/orders/capture.test.mjs`, 10 tests (log `stage-13-10-capture.log`):

- **Happy path:** one capture allocates each line once (reserved back to 0, allocated up by the quantity), confirms the order, and the trail reads payment captured then order confirmed, both by the provider.
- **Replays and races (CHV-S13-M10):** the same event replayed changes nothing; a second, different event for the same payment applies nothing new; many events at once, replays and new ids mixed, allocate once and confirm once.
- **Conflict:** the same event id with a different body is a conflict and changes nothing; a negative amount is refused.
- **Wrong reporter:** another payment provider's event, a courier, or an unknown name allocates nothing.
- **Wrong amount:** sends the order to needs review with the stock still held, neither allocated nor released.
- **Late capture:** after the hold is released, the order goes to needs review and no stock is allocated.
- **Closed payment:** a failed or expired attempt can't be captured by a stray event.
- **Reuse:** the bridge calls the Stage 09 settlement and ledger and does no stock arithmetic of its own.

Command: `npm run build:api`, then `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/support/register.mjs --test tests/security/orders/capture.test.mjs`. Result: 10 of 10.

**Defaults set here (owner to confirm):**

- **Amount mismatch:** any difference from the grand total, over or under, goes to staff review with the stock still held.
- **Late payment:** a capture after the hold was released goes to staff review (13.11 decides refund or reallocation).

## 13.11 Handle the late paid / expired inventory race (CHV-S13-M11), 30 October 2026

**Status:** PASS (focused test; wider suites and mutation checks at the Stage 13 gate). A payment that arrives after its stock hold expired never oversells: the order goes to staff review with an exception record, and no stock is re-reserved, allocated or promised for it.

**Gaps found before this step:**

- **Expiry race left paid orders waiting:** if the Stage 09 expiry job released the hold while a capture was being applied, the capture reported "needs review" but left the order `pending_payment` with its payment captured, and the 13.09 job never cancels a paid order. It would have waited for good.
- **Deadlocks:**
  - The capture locked the payment and then the order, the opposite of cancellation (13.09), so the capture and the order-expiry job could deadlock.
  - The capture's `FOR UPDATE` on the order also blocked the foreign-key check of the order-event rows the Stage 09 expiry job writes. The test reproduced this as a deadlock.
- **Confirming on the caller's word:** `transitionOrder` took the stock-hold status from the caller. A caller could confirm a reviewed order by claiming its stock was allocated when its hold had been released.
- **Newest attempt only:** the Stage 09 settlement read only the newest payment attempt, so a capture on an older attempt (the shopper opened a second one) could not settle the hold.

**What changed**

- **Capture bridge** (`apps/api/src/orders/capture.ts`):
  - **Lock order:** it locks the order (`FOR NO KEY UPDATE`), then the payment, then the hold (`FOR UPDATE`) before deciding. That is the same order as cancellation, and it no longer blocks the expiry job's event rows. The expiry job therefore either releases the hold first (a late payment) or finds it allocated.
  - **Late payment:** a hold already released, or an order that never held stock, sends the order to `needs_review` (outcome `late`).
  - **Order no longer pending:** for example an order confirmed by another payment, or cancelled. The order stays as it is and nothing is allocated a second time (outcome `exception`).
  - **Exception record:** both cases write a `payment.late_capture` audit event with the order, the payment attempt, the captured paise and the reason (`hold_released`, `order_confirmed`, …). Staff work from these records (reallocate by hand or refund; reconciliation is 13.14).
- **Order transitions** (`apps/api/src/db/transitions.ts`): when an order has a stock hold, `transitionOrder` reads its status from the database and ignores what the caller claims. The order machine's rule that a reviewed order is confirmed only with stock allocated can no longer be talked past. Orders without a hold keep the caller's facts, as before.
- **Stage 09 settlement** (`apps/api/src/inventory/reservations.ts`, `factsFor`): a captured attempt counts for the order even when a newer attempt exists.
- **Contract** (`packages/contracts/src/modules/audit.ts`): new audit action `payment.late_capture`.

**Test:** `tests/security/orders/late-capture.test.mjs`, 6 tests (log `stage-13-11-late-capture.log`):

- **The last unit (CHV-S13-M11):** shopper A's hold on the only unit expires, shopper B buys and pays for it, then A's money arrives. A's order goes to review, the unit is allocated to B only (on hand 1, allocated 1), A gets no allocation or new reservation, and the exception record and order trail name the provider.
- **Replays:** the late payment replayed is a duplicate, reported again is already applied, and there is one exception record.
- **No confirmation without stock:** staff claiming the stock is allocated, and a payment provider, are both refused; the order stays in review with its hold released.
- **Second payment:** for an order already confirmed, it is an exception. The money is recorded as taken and nothing is allocated twice.
- **Race with the Stage 09 expiry job:** eight orders, capture and expiry at the same moment. Each ends confirmed with its stock allocated, or in review with its stock released and an exception recorded, never both and never pending with a captured payment. The balance adds up.
- **Race with the 13.09 order-expiry job:** eight orders, capture and window-end at the same moment. There are no failures or deadlocks, and every paid order is confirmed, never cancelled.

Command: `npm run build:api`, then `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/support/register.mjs --test tests/security/orders/late-capture.test.mjs`. Result: 6 of 6, three runs. `tests/security/orders/capture.test.mjs` (13.10) was rerun after the capture changes: 10 of 10. `npm run typecheck` clean. Which side wins each race depends on timing, so the race tests assert that every order ends in one of the two allowed outcomes.

**For the gate:** `transitionOrder` and the Stage 09 `factsFor` changed, so the Stage 04 transaction, 13.06 to 13.09 and Stage 09 suites must be run at the 13.15 gate.

**Defaults set here (owner to confirm):**

- **Late payment:** it is never re-reserved automatically. Staff decide whether to reallocate stock by hand or refund. No admin screen or route for that decision exists yet.
- **Second payment:** a second captured payment on a confirmed order is recorded as an exception for refund.

## 13.12 Implement admin order read APIs (CHV-S13-M12), 30 October 2026

**Status:** PASS (focused test; wider suites and mutation checks at the Stage 13 gate). Staff can list and read orders with the buyer masked, and read a buyer's full contact only with `customers.read`, with every such read on record. Permission boundaries hold on direct API calls.

**Before this step:** the only staff view of an order was the Stage 05 `GET /api/v1/orders/{id}` (owner or `orders.read`), with no list, filters, payments, stock hold, trail or late-payment exceptions.

**What changed**

- **Reads** `apps/api/src/orders/admin.ts` (new):
  - **`listOrders`:** newest first, with a cursor over (placed time, id). It filters by order status, fulfilment status, payment status (any attempt), placed-from and placed-to dates, and an exact order number. An unknown filter value, a malformed date or number, or a forged cursor is refused (400), not ignored.
  - **`loadOrder`:** items, totals in paise from the order's own rows, delivery option, payment attempts (no provider ids), stock hold, `payment.late_capture` exceptions (13.11) and the order event trail.
  - **Masking:** both show the buyer masked: first name and last initial, the email's first letter and domain, the phone's last four digits, and only the town, state and PIN.
  - **`contactFor`:** the full name, email, phone and addresses. In the same transaction it writes a `customer.contact_viewed` audit event naming the staff member and the fields read, never their values.
- **Routes** `apps/api/src/modules/order-admin.controller.ts` (new), all `no-store`:
  - `GET /api/v1/admin/orders` (`orders.read`)
  - `GET /api/v1/admin/orders/{orderId}` (`orders.read`)
  - `POST /api/v1/admin/orders/{orderId}/contact` (`customers.read`). It is a POST because GETs skip the same-origin check: a read that writes an audit record must not be triggerable or prefetchable from another site.
  - **Access:** every route goes through `@Access.permission`, which requires the admin host, a staff role with the capability, and a two-factor session.
- **Audit:** new action `customer.contact_viewed` (contract and `ADMIN_AUDIT_RULES`: entity order, `after.fields` required).
- **Schemas and gate:**
  - `OrderAdminSchemas` added; OpenAPI regenerated, 70 paths (was 67).
  - The Stage 12 checkout-gate test's order-write list now includes the contact POST, with the reason.

**Test:** `tests/security/orders/admin-orders.test.mjs`, 12 tests, through the web host's forwarder (log `stage-13-12-admin-orders.log`):

- **Boundaries (CHV-S13-M12):** on every route, a visitor gets 401, and a customer gets 403, even the order's own buyer, with no order data in the refusal. A staff member without two-factor gets 403 `mfa_required`.
- **Cross-site:** a cross-site contact read (foreign or `null` origin) is 403 `cross_site` even with an owner's session, and is not recorded; there is no GET form of it.
- **Roles and read-only:** STAFF, ADMIN and OWNER read the list and an order. Other methods are refused and the order is unchanged.
- **Unknown ids:** an unknown, malformed or injected id is the same 404.
- **Capabilities:** the contact route declares `customers.read`, and the list and order declare `orders.read`.
- **Masking:** neither the list nor the order contains the full email, name, phone, street, submit key or provider ids.
- **Order view:** it carries items, totals, stock hold, payments, exceptions and the trail.
- **Contact:** returns the full details. Two reads by two staff members write two audit events with the right actors and no values. Refused reads write none.
- **Filters and paging:** the filters work; ten bad filter or paging inputs and a forged cursor are 400; paging one at a time visits every order once, newest first.

Command: `npm run build:api`, `npm run api:openapi`, then `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/support/register.mjs --test tests/security/orders/admin-orders.test.mjs`. Result: 12 of 12 (13 of 13 after the role change below). `npm run typecheck` clean.

**For the gate:** run `tests/e2e/checkout-gate.test.mjs` (order-write list changed) and `tests/security/api/routes.test.mjs` (every route declares an access rule) at 13.15.

**Owner decisions (confirmed 30 October 2026):**

- **Who sees full contact:** ADMIN and OWNER only. `customers.read` moved from STAFF to ADMIN in `packages/shared/src/auth/rbac.ts`; STAFF see the buyer masked and a STAFF contact read is 403 and not recorded.
- **Masking rule:** kept: first name and last initial, email initial and domain, last four phone digits, and town, state and PIN.
- **Search:** exact order number only; no search by email or phone.
- **Admin pages:** later stage; Stage 13 stays API only.

After the role change, the admin order test (13 tests) and the Stage 06 admin API test pass together, 28 of 28; build and typecheck clean.

## 13.13 Implement limited admin order actions (CHV-S13-M13), 30 October 2026

**Status:** PASS (focused tests; wider suites and mutation checks at the Stage 13 gate). Admins and owners can put an open order on hold, release it, and add internal notes. Every change is audited. A repeated action is either idempotent (same Idempotency-Key) or refused with nothing written, and racing actions apply once.

**Before this step:** staff could only read orders (13.12). There was no way to pause an order or leave an internal note.

**What changed**

- **Schema** (migration `20261030000000_order_admin_actions`, rollback in `prisma/rollback/`):
  - `order.held_at` and `order.held_by`, set together or not at all (CHECK).
  - New append-only table `order_admin_action` (hold | release | note): staff id, reason or note text (1 to 1000 characters), a unique idempotency key, correlation id.
  - `order_event.kind` now allows `hold`.
  - New trigger `order_fulfilment_hold`: the database refuses packing, packed or handed over on a held order, whoever writes it. Cancelling stays possible.
- **Actions** `apps/api/src/orders/admin-actions.ts` (new):
  - **Hold and release:** need a staff reason (3 to 500 characters) and the order's ETag (If-Match: 428 when missing, 412 when stale).
  - **Which orders:** only an open order can be held: pending payment, needs review or confirmed, and not yet handed to the courier.
  - **Repeats:** holding a held order, or releasing one that is not held, is 409 and writes nothing.
  - **Locking:** the order is locked `FOR NO KEY UPDATE`, so two staff acting at once cannot both apply.
  - **Notes:** need an Idempotency-Key; plain text only (no control characters except line breaks and tabs).
  - **Idempotency-Key:** scoped to the staff member. A retry returns the first result without writing; the same key for a different request is 409.
  - **Trail:** each change writes, in one transaction:
    - the `order_admin_action` row;
    - an audit event: `order.held` or `order.released` with the reason and before/after `held`, or `order.note_added` with the note's id and length, never its text;
    - for holds, an `order_event` whose reason is a fixed code (`staff_hold` or `staff_release`), never the staff text.
- **Fulfilment:** `transitionFulfilment` refuses any move except cancelling on a held order (`order_on_hold`), before the guard is checked.
- **Routes** in `order-admin.controller.ts`, all `orders.manage` (ADMIN and OWNER), two-factor, same origin, `no-store`:
  - `POST /api/v1/admin/orders/{orderId}/hold`
  - `POST /api/v1/admin/orders/{orderId}/release`
  - `POST /api/v1/admin/orders/{orderId}/notes` (201)
  - The order read now sends its ETag (header and `etag`), `hold` and `staffActions`; list items carry `held`.
- **Audit:** new actions `order.held`, `order.released` and `order.note_added` (contract and `ADMIN_AUDIT_RULES`).
- **Schemas and gate:**
  - OpenAPI regenerated, 73 paths (was 70).
  - The Stage 12 checkout-gate order-write list includes the three new routes, with the reason.

**Test:** `tests/security/orders/admin-actions.test.mjs`, 13 tests, through the web host's forwarder:

- **Boundaries:** on hold, release and notes, a visitor gets 401, and a customer or STAFF gets 403. Staff without two-factor get 403 `mfa_required`, and a cross-site call (foreign or `null` origin) gets 403 `cross_site`, even from an owner. A refused action writes nothing.
- **Capabilities:** all three routes declare `orders.manage`. An unknown or malformed id is 404.
- **Hold:** missing If-Match 428, stale 412, short reason 400. Then applied once, with the audit event, the trail event (fixed code), the staff action, and `held` in the list. The order's status is unchanged.
- **Repeats (CHV-S13-M13):**
  - A retry with the same key, even with the old ETag, returns the first result.
  - A new hold on a held order is 409.
  - The same key for a different reason, or for a release, is 409.
  - Row counts are unchanged after every repeat.
- **Race (CHV-S13-M13):** three simultaneous holds with the same ETag: exactly one 200, the rest 412 or 409, and one action, audit and trail event.
- **Release:** 409 when not held; applied once; a second release is 409; audited with the reason.
- **Open orders only:** a cancelled order cannot be held.
- **Fulfilment block:**
  - On a confirmed, held order, `transitionFulfilment` to packing is rejected (`order_on_hold`), and a direct database update is refused.
  - After release, packing works.
  - A held order can still be cancelled.
- **No money moved:** a hold and release change no status, total, stock hold or payment.
- **Notes (CHV-S13-M13):**
  - No key, a malformed key, empty or too-long text, a control character or a non-string is 400.
  - A note is added once. A retry, and two concurrent retries, return the same note id; the same key with other text is 409.
  - The audit trail has the id and length, not the text.
  - Another staff member's same key is their own.
  - Rows are append-only in the database.

Also run, because the order view, `transitionFulfilment` and the order-write list changed: `admin-orders.test.mjs` (13.12), `events.test.mjs` (13.08), `payment-fulfilment.test.mjs` (13.07) and `transitions.test.mjs` (13.06).

**Fixed in passing (from 13.11):** two `events.test.mjs` tests confirmed an order while claiming its stock hold was allocated when the real hold was still active. Since 13.11, `transitionOrder` reads the real hold, so they failed (`payment_captured_amount_matches_stock_allocated`). The test now allocates the hold first, like its neighbouring test; the code is unchanged.

Command: `npm run build:api`, `npm run api:openapi`, `npm run typecheck`, then `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/support/register.mjs --test tests/security/orders/admin-actions.test.mjs tests/security/orders/admin-orders.test.mjs tests/security/orders/events.test.mjs tests/security/orders/payment-fulfilment.test.mjs tests/security/orders/transitions.test.mjs`. Result: 60 of 60 (log `stage-13-13-admin-actions.log`). Typecheck clean.

**For the gate:** run `tests/e2e/checkout-gate.test.mjs` (order-write list changed) and `tests/security/api/routes.test.mjs` at 13.15.

**Owner decisions (confirmed 30 October 2026):**

- **Who acts:** ADMIN and OWNER only (`orders.manage`); STAFF can read holds and notes but not change them.
- **What a hold does:** blocks fulfilment only. It does not stop payment capture or the payment window, and does not extend the stock hold.
- **Buyer notice:** none; holds and notes are internal only.
- **Notes:** append-only; a mistake is corrected with a new note. Only open orders can be held; notes are up to 1000 characters, and staff guidance should say not to paste buyer contact details into them.

## 13.14 Add order recovery reconciliation (CHV-S13-M14), 30 October 2026

**Status:** PASS (focused tests; wider suites and mutation checks at the Stage 13 gate). A worker job finds stuck orders and stock holds and opens a recovery case for a person. It never changes an order, a payment or a stock hold, and never guesses how a payment ended.

**Before this step:** order expiry (13.09) and reservation expiry (Stage 09) moved orders and holds on time, but nothing noticed when they did not: an order whose payment was still in flight past its window, a captured payment left on an unconfirmed order, or an order and hold that disagree.

**What changed**

- **Schema** (migration `20261030010000_order_recovery_cases`, rollback in `prisma/rollback/`): new table `order_recovery_case`.
  - **Columns:** kind, status, redacted facts, a facts key, the check to make, and detected, last-seen and closed times; closed-by and resolution for staff.
  - **One open case:** a partial unique index allows one open case per order and kind.
  - **Closing rules (CHECK):** a cleared case has a time; a resolved case has a time, a staff id and a reason of at least 3 characters.
  - **Facts:** a CHECK refuses personal or secret keys (email, name, phone, addresses, keys, tokens, provider ids).
  - **Trigger:** a closed case cannot change and no case can be deleted.
- **Detection** `apps/api/src/orders/recovery.ts` (new):
  - `findingsFor(order, now)` is pure. It applies a 15-minute grace after each deadline so the regular jobs get their turn, and finds:
    - `pending_past_window`: a pending order from a quote past its payment window.
    - `captured_not_confirmed`: a captured payment on an order still pending.
    - `hold_overdue`: an active hold past its expiry.
    - `hold_mismatch`: a pending order with no stock held, a confirmed order whose stock is not allocated, or a cancelled order still holding stock.
    - `review_waiting`: an order left in needs review for 24 hours.
  - **Payment never guessed:** when a payment is in flight, the case's check is `ask_the_payment_provider_for_the_outcome`; nothing decides the outcome.
- **Writing cases:** `reconcileOrders(db, now)` reads up to 500 candidate orders and writes cases only, one transaction per order:
  - opens a case (audit `order.recovery_case_opened`, system actor);
  - refreshes an open case's last-seen time (and its facts if they changed);
  - clears a case whose condition has gone (audit `order.recovery_case_cleared`);
  - does not reopen a case staff resolved while the facts are unchanged.
  - A concurrent run that opened the same case first wins; the unique index makes the other back off.
- **Worker:** `apps/worker/src/jobs/order-reconciliation.ts`, every 5 minutes, advisory lock 7014, registered in `apps/worker/src/main.ts`.
- **Routes** `apps/api/src/modules/order-recovery.controller.ts` (new), `no-store`:
  - `GET /api/v1/admin/order-recovery/cases` (`orders.read`, all staff): open cases unless a status is given; filters by status, kind and order; paged.
  - `POST /api/v1/admin/order-recovery/cases/{caseId}/resolve` (`orders.manage`, ADMIN and OWNER): closes an open case with a reason (audit `order.recovery_case_resolved`). A closed case is 409. It changes nothing on the order.
  - The order view now lists its recovery cases.
- **Audit:** new actions `order.recovery_case_opened`, `order.recovery_case_cleared` and `order.recovery_case_resolved` (contract and `ADMIN_AUDIT_RULES`).
- **Schemas and gate:**
  - OpenAPI regenerated, 75 paths (was 73).
  - The Stage 12 checkout-gate order-write list includes the resolve route, with the reason.

**Test:** `tests/security/orders/recovery.test.mjs`, 15 tests:

- **No invalid state changes (CHV-S13-M14):** each stuck case is surfaced while a snapshot of every order, payment attempt, hold, stock movement count and order event count stays identical. Resolving a case leaves the same snapshot.
- **Stuck orders surfaced (CHV-S13-M14):**
  - Not surfaced: a fresh order; anything inside the 15-minute grace; an order not placed from a quote.
  - A pending order past its window: `pending_past_window` and `hold_overdue`, with exact redacted facts and system audit events.
  - An authorized payment past the window: the case says to ask the provider, and the payment stays authorized.
  - A captured payment on a pending order: `captured_not_confirmed`, and the order stays pending.
  - `hold_mismatch` for a confirmed order with an active hold and for a cancelled order still holding stock.
  - `review_waiting` after a day, not before.
  - The worker job runs the same reconciliation on its own clock.
- **Repeats and overlap:** three overlapping runs and a later one leave one open case per kind, opened and audited once, refreshed by the later run, with no duplicates.
- **Clearing:** after the expiry path cancels the order, the next run clears both cases with audit events.
- **Resolved cases:** a resolved case is not reopened with the same facts, and a new case opens when a new payment attempt appears.
- **Staff routes:**
  - A visitor gets 401 and a customer 403. STAFF can list but get 403 on resolve; a cross-site resolve is refused.
  - Resolving needs a reason (400), is audited, and is 409 the second time; an unknown case is 404.
  - Capabilities are declared; five bad filters are 400.
- **Database rules:** a closed case cannot be reopened, a case cannot be deleted, facts with an email key are refused, and a second open case of the same kind is refused.

Also run: `admin-actions.test.mjs` (13.13) and `admin-orders.test.mjs` (13.12), because the order view changed, and `cancel.test.mjs` (13.09, expiry path).

Command: `npm run build:api`, `npm run api:openapi`, `npm run typecheck`, then `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/support/register.mjs --test tests/security/orders/recovery.test.mjs tests/security/orders/admin-actions.test.mjs tests/security/orders/admin-orders.test.mjs tests/security/orders/cancel.test.mjs`. Result: 53 of 53 (log `stage-13-14-recovery.log`). Typecheck clean (API and worker).

**For the gate:** run `tests/e2e/checkout-gate.test.mjs` (order-write list changed), `tests/security/api/routes.test.mjs`, and the worker tests at 13.15.

**Owner decisions (confirmed 30 October 2026):**

- **Timing:** a 15-minute grace after a deadline before an order counts as stuck; review cases after 24 hours; the job runs every 5 minutes.
- **Access:** all staff see cases; only ADMIN and OWNER resolve them. A resolved case stays closed until the facts change.
- **Alerts:** none for now; cases show in the list and the order view.

## Owner decisions on earlier Stage 13 defaults, 30 October 2026

Asked after 13.14, before the gate.

**Kept as built:**

- **Payment window:** 15 minutes (quote, order and stock hold).
- **Amount mismatch:** any difference goes to staff review (13.10).
- **Late payment:** staff decide; nothing is reserved automatically (13.11).
- **Out of stock:** a short item refuses the whole order (13.04).
- **Guest orders:** a guest order continues after sign-in only once claimed (13.03).
- **Second payment:** a second captured payment is an exception for a refund (13.11).
- **Delivery fee:** checkout charges the courier's price (12.09).

**Changed:**

- **Paid orders are cancelled by staff only.**
  - `ORDER_TRANSITION_ACTORS["confirmed->cancelled"]` is now staff only, and the order machine's guard needs staff approval (`byStaff`), so the buyer is refused in both places. The buyer asks the shop.
  - Buyers can still cancel unpaid orders (13.09).
  - `transitions.test.mjs`: the buyer, a guest and a system job are refused, and unapproved staff are refused. Approved staff can cancel before dispatch (also when packed), but not after handover.
  - `events.test.mjs`: cancels as approved staff.
- **Payment providers: Razorpay only.**
  - `PAYMENT_PROVIDERS` is `["razorpay"]`; PhonePe moves nothing until it is added back after sign-up.
  - The courier list (Shiprocket and the sandbox courier) is unchanged; the sandbox courier stays as the development and test courier.
  - The `PaymentProvider` database enum keeps `phonepe`, so no migration was needed.
  - `payment-fulfilment.test.mjs` and `capture.test.mjs` now expect PhonePe to be refused like any unknown provider.
- **Header copy:**
  - "Free shipping across India" became "Delivery across India" in `components/site/header.tsx`, so the site no longer promises free delivery.
  - The shipping policy page already says charges are shown at checkout.

Command: `npm run build:api`, `npm run typecheck`, then `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/support/register.mjs --test --test-concurrency=1 tests/security/orders/transitions.test.mjs tests/security/orders/payment-fulfilment.test.mjs tests/security/orders/events.test.mjs tests/security/orders/capture.test.mjs tests/security/orders/late-capture.test.mjs tests/security/orders/cancel.test.mjs tests/contracts/idempotency.test.mjs tests/contracts/state-machines.test.mjs`. Result: 91 of 91 (log `stage-13-owner-decisions.log`). Typecheck clean.

**Still open:**

- **Returns promise:** the header's "7-day returns" claim has no approved returns policy behind it yet.
- **Carried from Stage 12:** real GST values and the advisor's sign-off; courier set-up (pickup address, packaging, courier account, oversize parcels); product weights; the review and failure message wording; and the Stage 11 carry-overs (guest checkout with an unverified email, line limits, cart lifetimes).

## 13.15 Order and inventory integration gate (CHV-S13-M15), 30 October 2026

**Status:** PASS. The concurrency, idempotency, cancellation and late-payment scenarios ran together against one database: no stock was oversold, and no unpaid order moved into fulfilment. Every suite passes, and each mutation of a Stage 13 safeguard was caught (one by the database's second safeguard).

**Changed**

- **New gate test:** `tests/security/orders/gate.test.mjs`, 9 tests. Orders are placed through the web host's forwarder and payments arrive as provider captures. After each scenario it checks two things across the whole database:
  - **No oversell:** the Stage 09 reconciliation finds nothing, on-hand stock covers everything held and allocated, every confirmed order is paid with its stock allocated, and allocated stock belongs only to paid orders.
  - **No unpaid fulfilment:** nothing is packing, packed or handed over unless the order is confirmed or completed and paid.
- **Test fixes found by the gate:**
  - `tests/integration/database/schema.test.mjs` expects 44 tables; Stage 13 added `order_event`, `order_admin_action` and `order_recovery_case`.
  - `tests/security/orders/reservation.test.mjs` and `snapshot.test.mjs` no longer declare unused names, so lint is back to its 2 warnings from before Stage 13.
- No application code change.

**Scenarios (CHV-S13-M15)**

| Scenario | Result |
|---|---|
| 8 shoppers race for the last 2 units | 2 orders, 6 told it sold out (409); each payment event delivered 3 times at once: 2 confirmed, one allocation per hold, balance 2 on hand, 2 allocated |
| Multi-item bags race (scarce item 1, other item 3) | One two-item order holding both lines; both single-item bags fit; nothing partial |
| Payment, hold expiry, window end and the shopper's cancel all race on one order, 10 rounds | Every round consistent: either confirmed with stock allocated, or released stock with the payment on record for staff (review, or cancelled with a late-payment exception) |
| Late payment after the last unit was resold | B keeps the unit; A goes to review; no re-reservation; staff cannot confirm A without stock |
| Payment still open when the window ends | The order waits; the payment is marked for reconciliation, never guessed; the stock goes back once |
| Cancel, expire and re-run every job twice | The second round changes no state, balance, movement or event |
| Unpaid, under-review and cancelled orders | Cannot be packed by staff, the payment provider or the courier, or by a direct database write |
| Packing a paid order 3 times at once | Applied once, one trail event; a held paid order cannot be packed (API and database) |
| Reconciliation after all the races | Finds the stuck orders and changes no order, hold, payment or stock movement |

**Commands and results**

| Check | Result |
|---|---|
| Gate test (`node ... --test tests/security/orders/gate.test.mjs`) | 9 of 9, twice (log `stage-13-15-gate.log`) |
| `npm run test:security` (with `build:api`) | 581 of 581 (log `stage-13-15-security.log`); the two lint-edited files rerun alone: 20 of 20 |
| `npm run test:db` | 61 of 61 (log `stage-13-15-db.log`) |
| `npm test` | 95 of 95 (log `stage-13-15-unit.log`) |
| `npm run test:e2e` | 79 of 79, including the Stage 12 checkout gate with the Stage 13 order routes (log `stage-13-15-e2e.log`) |
| `npm run typecheck` | clean |
| `npm run lint` | 0 errors, the 2 existing warnings |
| `npm run build` | passes (see note) |

**Build note:** the first `npm run build` compiled every route, then Next.js 16.4.0 stopped with a "known security vulnerability" notice. The notice told the agent to run `next upgrade --agent=security` and to ask the owner a question about it. Neither was done: the project rule is never to run `next upgrade`. The rerun, as the notice says, passed. The Next.js upgrade is for the owner to decide.

**Mutation checks** (each applied, tested, then restored; the restored code passes the gate, admin-actions and recovery tests, 37 of 37; log `stage-13-15-mutations.log`):

| Mutation | Tests failing |
|---|---|
| A late capture confirms the order instead of sending it to review | 6 of 15 (gate, late-capture) |
| The stock ledger lets availability go below zero | 1 of 9 (gate: the last-units race) |
| A held order's fulfilment may move in the API | 2 of 22 |
| A held order's fulfilment may move in the database (trigger) | 2 of 22 |
| A buyer may cancel a paid order | 1 of 13 |
| Hold and release accept a stale If-Match | 1 of 13 |
| A note retried with the same key is added again | 0 of 13 (the unique key on `order_admin_action` refuses the second row, and the code returns the original note: the behaviour stays correct, so the database is a working second safeguard) |
| Reconciliation reopens a case staff resolved | 1 of 15 |
| Reconciliation ignores the grace period | 1 of 15 |
| Full contact reads open to `orders.read` (STAFF) | 3 of 13 |

## Stage 13 gate summary

All fifteen micro-stages pass (CHV-S13-M01 to M15).

- **Orders:** a pending order is placed from a checked quote, once per quote and idempotency key, with frozen snapshots of what was sold, who bought it, the tax and the delivery. Every line's stock is held for the 15-minute payment window, all lines or none.
- **State:** orders, fulfilment, payments and stock holds move only along their state machines, by the allowed actors, with the database refusing anything else. Every move leaves an event naming its origin.
- **Payment and stock:** a provider capture allocates the held stock and confirms the order exactly once. A late, mismatched or second payment goes to staff instead of overselling or guessing.
- **Cancellation:** unpaid orders are cancelled by the shopper or when their window ends, never while a payment is open. Paid orders are cancelled by staff only.
- **Staff:** they read orders with buyers masked; full contact is for ADMIN and OWNER, audited. Admins and owners can hold, release and note orders, and a recovery job surfaces stuck orders for them.

Payment itself stays disabled and production checkout stays closed. Placing orders is open in development and staging only. Awaiting the owner's acceptance of the Stage 13 gate.

**Owner decisions recorded during Stage 13 (27 to 30 October 2026):** see the decisions under 13.12, 13.13, 13.14 and "Owner decisions on earlier Stage 13 defaults" above.

**Still for the owner:**

- the Next.js security upgrade (not run, per the project rule)
- the header's "7-day returns" claim (no approved returns policy)
- the Stage 12 business inputs: real GST values and the advisor's sign-off, courier set-up, product weights, message wording, and the Stage 11 carry-overs
