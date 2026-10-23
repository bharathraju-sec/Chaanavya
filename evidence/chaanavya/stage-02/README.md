# Stage 02 evidence: architecture contracts and commerce invariants

Captured 15 October 2026 in the upgrade workspace `backup/upgrade` (copy of main 7347829; main is 60ea71a). Design and contracts only: no database, payment gateway, courier or email provider exists, and the storefront does not import any of the new code (`change-scope.txt`).

## Deliverables

| Path | Contents |
| --- | --- |
| `lib/modules/contracts/` | Versioned DTOs and service interfaces for catalogue, cart, checkout, order, payment, inventory, shipment, returns, audit; `state-machines.ts` (7 machines, 67 transitions); `invariants.ts` (pricing, totals, stock) |
| `lib/integrations/contracts/` | `PaymentGateway`, `CourierGateway`, `NotificationSender` ports |
| `tests/contracts/` | 37 contract tests (`npm test`) |
| `scripts/print-state-machines.mjs` | Generates the transition tables in the state machine document |
| `eslint.config.mjs` | UI may not import provider ports, provider SDKs or server-only Shopify/chat/newsletter modules |
| `docs/architecture/commerce-contracts.md` | Vocabulary, module boundaries, ports, invariants with tests, data authority and reconciliation |
| `docs/architecture/order-state-machine.md` | How the machines interact, exception paths, generated tables |
| `docs/DECISIONS.md` 012 to 019 | Scope, separate machines, tax, promotions, order IDs, snapshots, images, test runner |

`docs/` is local and unversioned, as before.

## Results

| File | What it shows |
| --- | --- |
| test.log | `npm test`: 37 tests, 37 pass, exit 0 |
| lint.log | `npm run lint`, exit 0 |
| typecheck.log | `npm run typecheck`, exit 0 |
| build.log | `npm run build`, exit 0, same 14 routes as Stage 01 |
| lint-guard-probe.log | A temporary UI file importing a provider port and `@/lib/shopify` fails lint with 2 errors (file deleted afterwards) |
| mutation-check.log | Three invariants broken on purpose in a scratch copy (client price used, packing without a confirmed order, deduplication disabled): 3 tests fail, so the tests detect them |
| change-scope.txt | Files changed against main; no storefront file imports the contracts |

## Test case status

| Case | Status |
| --- | --- |
| CHV-S02-001 every order/payment/shipping transition has a declared precondition | Pass: all 7 machines, plus reachability, terminal-state and fail-closed checks |
| CHV-S02-002 frontend price edits do not change the server-accepted amount | Pass, against the reference `priceLines`/`matchesServerAmount`. The real server route arrives in Stage 11/12 and must reuse these tests |
| CHV-S02-003 duplicate provider events have stable idempotent semantics | Pass, against the reference `replayPaymentEvents`. Database-backed proof is Stage 14 |

Definition of done: vocabulary written (agreement pending a reviewer); module boundaries and provider ports documented; invariants testable and tested; no duplicate source of truth (review in `commerce-contracts.md`).

## Hand-off: unresolved blockers for Stage 03

1. Decision 012 (Shopify independence) is proposed, not approved; `docs/AGENTS.md`, `PRD.md` and `DATABASE.md` still forbid a local database, custom checkout and accounts. Needs the owner before Stage 04.
2. No accountable reviewer named for Stage 01 or 02.
3. Owner or tax-advisor input needed: GST-inclusive pricing and tax ownership (014), promotion stacking (015), order number format (016), return window and eligible categories.
4. `npm test` needs Node 22.18 or newer; `package.json` engines still say 20.9. Stage 03 should pin the CI Node version.
5. Production Vercel environment variables still unverified (from Stage 01).
6. Local development still writes newsletter sign-ups to the live Shopify customer list (from Stage 01).
