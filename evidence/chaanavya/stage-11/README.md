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
