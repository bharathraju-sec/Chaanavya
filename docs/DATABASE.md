# Chaanavya Data Model

## Data ownership

There is no local SQL or document database, schema migration framework, or ORM. Shopify owns live products, variants, carts, checkout, and downstream commerce records. This file documents the application's consumed model and browser persistence rather than inventing application tables.

## Catalog model

Definitions are in `lib/types.ts`; upstream normalization is in `lib/shopify.ts`.

| Entity | Fields |
| --- | --- |
| Money | `amount` as decimal string; `currencyCode` as string |
| ProductImage | `url`, nullable `altText`, optional nullable `width` and `height` |
| Variant | `id`, `title`, `availableForSale`, `price`, optional image, `selectedOptions` |
| Selected option | `name`, `value` |
| Product option | `name`, `values[]` |
| Product | `id`, `handle`, `title`, `description`, `productType`, `tags[]`, featured image, images, variants, options, optional demo collections |
| CartLine view | `id`, `quantity`, `title`, `handle`, `option`, image URL, price |

Product has many variants and images. Variant choices correspond to named product options. Live products use Shopify GIDs; fallback IDs use `demo:` prefixes. `collections` is assigned only to built-in fallback products; live collection nodes are not fetched.

Money formatting uses `Intl.NumberFormat("en-IN")`, the supplied currency, and zero decimals for integer amounts or two otherwise. Number and absent-money fallbacks use INR. Do not assume every live amount is INR solely from demonstration data.

## Shopify cart representation

The route returns cart ID, checkout URL, total quantity, subtotal and total amount, and up to 100 line nodes. Each node includes line ID, quantity, and variant merchandise details. The client cart type consumes subtotal but does not currently consume returned total amount or warning fields.

Cart line IDs identify mutation targets; variant IDs identify merchandise to add. They are different and must not be interchanged. A valid cart response is the authority for live subtotal and line quantities.

## Browser persistence

| Key | Stored value | Lifetime and synchronization |
| --- | --- | --- |
| `chaanavya-shopify-cart-v1` | JSON string containing full Shopify cart ID | Persists until cleared; restored on live mount; no cross-tab state subscription |
| `chaanavya-demo-cart-v2` | JSON array of demo CartLine values | Persists locally; storage and `chaanavya:demo-cart` events update subscribers |
| `chaanavya-wishlist-v2` | JSON array of product handles | Persists locally; storage and `chaanavya:wishlist` events update subscribers |

Browser values are untrusted and device-specific. There is no retention timer, account association, server synchronization, or migration between demo and live bags. Storage exceptions are caught in several helpers, but parsed values are not comprehensively schema-validated. Denied storage and valid JSON of the wrong shape require regression scenarios.

Cart IDs can contain a `?key=` component. Treat the full value as sensitive; redact it in logs, screenshots, and support records.

## Validation and limits

The API validates GID prefixes, whitespace and length, line-list size, and integer quantity bounds. See `API.md` for the precise limits. The picker resolves selection to an available variant; Shopify remains the authority for current inventory and pricing at mutation and checkout time.

The demonstration subtotal uses JavaScript numeric arithmetic and is not an accounting record. No payment or customer address fields are persisted by application code in this repository.

## Data change rules

- Update shared types, upstream selection fields, normalization, API contracts, and affected UI together.
- Do not add local product or order tables merely to duplicate Shopify records.
- If a future service needs persistence, first document its owner, fields, access rules, retention, deletion, and migration plan.
- Changing browser key versions requires an explicit migration or reset decision. Do not silently overwrite a live cart reference with demo data.
- Keep fixture data visibly separate from approved live merchandise.

## Open questions

Confirm whether customer accounts, server-side wishlists, contact records, newsletter consent history, or verified tracking records are required. No schema is proposed until their workflow and ownership are decided.
