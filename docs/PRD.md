# Chaanavya Product Requirements

## Product and purpose

Chaanavya is a web storefront for women's fashion, with an India-focused presentation and INR demonstration prices. Shoppers browse collections, inspect products, select available variants, manage a bag, and continue to Shopify-hosted checkout. The current design direction is warm editorial.

The working product goal is to make merchandise discoverable and purchasable through a coherent storefront. This is inferred from the implementation; revenue targets, audience research, launch dates, and conversion targets are not supplied.

## Users and jobs

| User | Job |
| --- | --- |
| Shopper | Browse the range, understand product details and fit, choose an available variant, and purchase |
| Returning shopper | Recover a bag on the same browser and revisit locally saved favorites |
| Customer needing help | Find policies, contact information, sizing, and order support |
| Store operator | Maintain products, variants, availability, and checkout settings in Shopify |
| Developer | Maintain the storefront and its integration without duplicating Shopify commerce logic |

These are functional roles, not validated customer personas. No storefront account or administrator UI is implemented.

## Current scope

| Feature | Current behavior | Acceptance criteria |
| --- | --- | --- |
| Home | Editorial sections, product grid, collection links | Navigation and product links work; content stays readable across screen sizes |
| Collections | New arrivals, dresses, ethnic and festive, jewelry, fragrance | Known slugs render; unknown slugs return not found; empty lists show a message |
| Product details | Gallery, description, price, option picker, policy links, related products | Unknown handles return not found; only an available, resolved variant can be added |
| Quick add | Direct add for products without choices; dialog otherwise | Required choices are explicit; unavailable combinations are disabled; dialog closes after a successful add |
| Live bag | Shopify cart create, restore, add, update, and remove | Subtotal comes from Shopify; failures are visible; reload restores a valid cart ID |
| Demonstration bag | Browser-local lines and computed subtotal | Demo IDs never become real merchandise; checkout is disabled |
| Checkout | Navigate to an HTTPS checkout URL returned by Shopify | Empty, busy, or demo bag cannot check out; actual payment flow is verified separately |
| Search | Client-side label matching across pages and loaded products | Case-insensitive matching; empty-result message; a result navigates correctly |
| Wishlist | Local product-handle toggles | Heart state persists in normal browser storage; no account synchronization is implied |
| Support and policies | Static pages plus frontend-only forms | Form messages accurately describe preview behavior; approved content required for launch |

## Routes

`/`, `/new-arrivals`, `/dresses`, `/ethnic-festive`, `/jewelry`, `/fragrance` (`/essentials` redirects here), `/products/[handle]`, `/contact`, `/track-order`, `/size-guide`, `/shipping-policy`, `/refund-policy`, `/privacy-policy`, and `/terms`. The bag, search, and quick add are overlays rather than standalone routes.

## Launch requirements

- Use approved merchandise, imagery, descriptions, prices, and availability in the live Shopify catalog.
- Verify option selection, bag restoration, mutations, and the complete Shopify checkout handoff in a controlled environment.
- Confirm shipping coverage, charges, taxes, payment methods, returns, cancellation terms, legal identity, and support contacts. Existing page text is not proof of approval.
- Resolve organic cotton versus broader boutique positioning consistently across metadata, logo text, home copy, and policies.
- Choose an email service before re-adding a newsletter sign-up (removed 14 October 2026). Do not claim a subscription without a successful backend response. Contact and tracking link to email, WhatsApp and Shopify customer accounts (14 October 2026).
- Validate responsive layout, keyboard access, focus behavior, contrast, and reduced motion against `DESIGN_SYSTEM.md`.
- Establish release checks, production monitoring, and a recovery procedure.

## Non goals and unresolved scope

There is no custom payment processor, local product database, customer account area, order dashboard, standalone wishlist page, full-text search service, discount engine, subscription billing, or admin panel in this repository. Adding any of these is a new scope decision. Do not infer international shipping or confirmed Razorpay configuration from template policy text.

## Constraints and risks

Shopify owns live commerce records. The current catalog fetch is limited to 50 products, with 30 variants and eight images per product. Search only covers that loaded catalog. Page rendering is per request for the nonce-based CSP; catalog responses are cached for 300 seconds. Fallback merchandise is demonstration content, including stock imagery and placeholder prices, and is never shown on the production deployment.

## Success measures

Proposed measures: successful product-to-bag journeys, successful checkout handoffs, cart mutation failure rate, and support submission success after integration. Numerical targets and analytics collection require owner decisions. No metrics integration currently records these measures.

## Open decisions

| Question | Decision needed from |
| --- | --- |
| Is the brand focused on organic cotton or a broader fashion range? | Owner |
| Which products, claims, imagery, and size measurements are approved? | Owner and catalog operator |
| Should fallback merchandise ever appear on production pages during outages? | Decided 14 October 2026: no; production shows a store-unavailable message |
| Which email, support, and order tracking services should be connected? | Owner and maintainer |
| Which payment provider and shipping settings are active in Shopify? | Store operator |
| Are the 50-product and 30-variant limits adequate for launch? | Catalog operator and maintainer |
| What are the launch date, business targets, and production alert recipients? | Owner |

## Definition of done

A feature satisfies explicit acceptance criteria, preserves existing journeys, passes applicable lint/type/build checks, has relevant behavior verification, exposes no secrets, and updates affected documentation. A storefront launch additionally requires the checks in `DEPLOYMENT.md`; the existence of these documents is not launch approval.

## Source files

`app/page.tsx`, `app/layout.tsx`, collection and product routes, `components/product/`, `components/cart/`, `components/site/`, `lib/shopify.ts`, and `lib/collections.ts`.
