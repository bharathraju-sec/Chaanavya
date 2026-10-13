# Chaanavya Roadmap

This is a proposed sequence based on repository gaps. It is not a committed schedule; dates, budget, and business priorities remain with the owner. Each item should become a scoped task with acceptance criteria before implementation.

## Now

| Work | Completion evidence |
| --- | --- |
| Resolve brand positioning and merchandising | Approved copy, imagery, product claims, and consistent metadata |
| Confirm Shopify commerce setup | Real catalog, variants, stock, currency, shipping/tax/payment settings and controlled checkout verification |
| Finalize policies and support identity | Approved business details and terms; no unresolved placeholders |
| Decide production outage behavior | One consistent catalog/purchase mode; no accidental demo-to-live mutation |
| Verify production boundaries | Mock false and robust production guard; deployed headers and platform rate controls checked |
| Establish acceptance baseline | Lint/type/build results plus critical browsing, bag, mobile, keyboard, and checkout scenarios |

## Next

- Connect contact and newsletter to chosen services with server validation, delivery feedback, abuse controls, and data-handling rules.
- Order tracking links to Shopify customer accounts (done 14 October 2026); verify it with a real order before launch.
- Add reliable cart restoration/recovery, storage validation, and appropriate handling of warnings and ambiguous failures.
- Reconcile design documentation with rendered tokens and verify smaller quantity-button touch targets.
- Add focused automated tests and a checked-in CI workflow after selecting tooling.
- Add sanitized error/fallback instrumentation, alerts, and an incident owner.

## Later

- Fetch actual Shopify collection membership and support catalog/variant pagination when the catalog requires it.
- Improve search beyond the loaded label list if merchandising needs justify it.
- Consider product-specific sizing and approved content management workflows.
- Review performance using actual measurements before changing caching or rendering policy.

## Deferred pending explicit scope

Customer accounts, a standalone wishlist page, cross-device favorites, loyalty, discounts, international markets, custom analytics, and an operator dashboard. None should be implied by the current implementation.

## Outside the current architecture

Custom payment handling and a duplicate local product/order database are not part of the documented storefront. Adding them requires a concrete requirement and architecture decision.

## Review process

Review priorities when the owner supplies business decisions or verification reveals a blocker. Keep completed work in `CHANGELOG.md`; keep unresolved decisions in `PRD.md` and `DECISIONS.md`. Do not mark a proposed item complete based solely on a documentation entry.
