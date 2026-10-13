# Chaanavya Testing Strategy

## Current verification tooling

The repository defines `npm run lint`, `npm run typecheck`, and `npm run build`. No test runner, test script, checked-in test suite, or CI workflow was found at the baseline. This documentation task does not claim to have run application validation or live checkout.

```powershell
npm run lint
npm run typecheck
npm run build
```

Run these for applicable application changes. Markdown-only edits need document consistency checks, not a rebuild unless they also change application configuration. A successful build does not prove Shopify compatibility, usable forms, correct inventory, accessibility, or payment completion.

## Test environments

| Mode | Setup | What it can establish |
| --- | --- | --- |
| Built-in fallback | Shopify credential or domain absent; external mock false | Demo catalog rendering, selection, local bag, disabled checkout |
| External mock | `SHOPIFY_USE_MOCK=true` outside Vercel production | External GraphQL transport if compatible; not real store readiness |
| Controlled Shopify | Approved non-production store/configuration with known fixtures | Live product, cart, stock, restore, and checkout handoff contracts |
| Production smoke | Verified production domain/configuration | Deployed behavior with non-destructive checks and approved purchase testing |

Do not use fabricated production GIDs as successful test fixtures. Do not place real orders just to test a documentation change. Record the environment and product fixture for every live result.

## Manual acceptance scenarios

| Scenario | Expected result |
| --- | --- |
| Home and all five collection links | Correct route and visible products or empty state |
| Unknown collection and unknown handle | Not-found experience; no runtime error |
| Search mixed-case query | Matching labels, at most 12 results, correct navigation |
| Search with no matches | Clear empty message and usable close control |
| Multi-option product | Required choices resolve exactly one available variant |
| Sold-out product or combination | Add disabled; unavailable choice clearly indicated |
| One-variant product | Quick add without unnecessary option dialog |
| Live first and subsequent add | Correct Shopify variant; quantity and subtotal updated |
| Quantity increase, decrease, remove | Shopify result displayed; zero removes line in current UI |
| Reload with valid live cart | Same bag restored |
| Expired or missing live cart | Reference cleared; next add can create a new cart |
| Fallback mode | Demo bag persists with normal storage; checkout remains disabled |
| Wishlist toggle and reload | Pressed state persists; no server synchronization implied |
| Checkout handoff | HTTPS destination is the intended Shopify checkout with the intended lines |
| Contact, tracking | Email, WhatsApp and Shopify account links open the right destinations; no forms or customer data |
| Missing product image | Stable image well and usable title/action |

## Failure and boundary scenarios

- Catalog timeout/error, including layout and page fetches returning different modes.
- Cart timeout, upstream user error, null mutation cart, and malformed response.
- Invalid content type, malformed JSON, unsupported action, wrong GID kind, empty or 21-line lists, quantity below minimum or above 99, and excessive request size.
- Cross-site browser request returns 403; repeated requests to one instance produce 429 and `Retry-After`.
- Temporary restoration failure currently clears the saved cart ID; verify and document that behavior until recovery changes.
- Storage denied, malformed JSON, and valid JSON with the wrong shape. Test live cart references, demo arrays, and wishlist arrays separately.
- Multiple tabs: demo and wishlist synchronization; live cart state can become stale.
- Catalogs over 50 products, products over 30 variants, and carts over 100 lines require explicit truncation/pagination review.
- Validate mock mode protection under the actual host; Vercel-only checks are not sufficient evidence for other production hosts.

## Accessibility and presentation

Check 375, 768, 1024, and 1440px; navigation around 900/901px; long names; error messages; product galleries; and bag overflow. Verify keyboard-only browsing, skip link, focus visibility and restoration, dialog close behavior, labelled controls, touch targets, and reduced motion. Check both primary content and overlays. Requirements in the design master are not proof that every current control meets them.

## Proposed automated coverage

Choose a runner deliberately before adding dependencies. Prioritize variant resolution and availability, collection matching, money formatting, API validation, cart error handling, and a browser purchase journey using controlled fixtures. Avoid live payment dependencies in routine CI. Use a small number of meaningful tests instead of tests that merely duplicate implementation statements.

## Result record

For each change record revision, environment/mode, commands and exit results, scenarios checked, fixture identifiers without sensitive keys, remaining failures, and checks not run. Distinguish code checks from browser verification and real Shopify verification.

## Definition of done

Applicable checks pass; affected critical journeys are verified; regressions and known limits are recorded; no secret appears in output; and documentation agrees with the changed behavior. Launch also requires `DEPLOYMENT.md`.
