# Chaanavya Failure Behavior

## Current behavior

| Failure | Handling | Customer effect |
| --- | --- | --- |
| Shopify configuration absent | Outside production: fallback and `live:false`. Production: no products, `unavailable:true` | Outside production: demo products and bag, checkout disabled. Production: "The store is temporarily unavailable"; product pages show `app/error.tsx` |
| Invalid Shopify configuration | `isStoreLive` returns false; API reports 500 | Catalog fallback or generic unavailable error |
| Catalog HTTP, GraphQL, or network failure | Read helpers catch: fallback outside production, `unavailable` (lists) or `StorefrontError` (product page) in production | Production pages stay up with a store-unavailable message; never demonstration merchandise |
| Product not found | Product route calls `notFound()` | Not-found page |
| Collection unknown | Restricted slugs and `notFound()` | Not-found page |
| Collection empty | Grid renders an empty message | No purchase cards |
| Cart transport failure | Client throws API error text; mutation catches and toasts | No successful mutation state applied; busy resets |
| Shopify mutation user errors | `unwrap` throws their messages | Error toast; quick add remains open |
| Missing mutation cart/result | `Invalid cart response` | Error toast |
| Saved cart missing or restoration fails | Stored cart ID removed | Empty bag; next live add creates a new cart |
| Missing image | Empty aspect-ratio image well | Stable layout without an image |
| Invalid checkout URL | HTTPS check returns null | Checkout button disabled |
| Form invalid | Browser required/type validation | Submission prevented |
| Form valid | Local message only | No server delivery, subscription, or tracking |
| Chat credentials absent | Chat endpoint returns 503 | Chat displays support/contact fallback |
| Chat request invalid or too large | 400 or 413; content type and origin checks return 415 or 403 | No model request is made; history must alternate roles and start/end with a user message |
| Chat rate limit reached | 429 with `Retry-After` | Shopper is asked to wait or contact support |
| AI Gateway request fails or times out | 502 with a generic message; provider details and prompt are not returned | Chat displays contact fallback and a "Try again" button that resends the last message; failed exchanges are not sent back to the model and any draft in the message box is kept |
| Order/tracking question | Answer locally with Shopify customer account link | No order record is queried |

Shopify Storefront requests use an eight-second timeout; AI Gateway chat requests use a 25-second timeout. Explicit API status codes and JSON messages are defined in `API.md`. Browser errors are announced through Sonner.

## State and retry rules

Live cart state changes only after a valid mutation result. The shared busy state resets in `finally`. The application does not automatically retry failed cart mutations or provide an offline queue. Shoppers may retry manually; after an ambiguous timeout, restoring the authoritative cart before another add is a proposed improvement to avoid accidental duplicates.

Storage read/write helpers catch several browser exceptions, but do not enforce complete runtime schemas. Demo operations depend on persisted snapshots; denied storage may prevent visible changes even where write helpers suppress errors. Wishlist reads can fail on inaccessible storage or values of the wrong shape. Treat storage degradation as an unresolved test and improvement area rather than guaranteed full functionality.

## Catalog provenance gap

Root layout gets `live` from one catalog call, while pages make separate calls. During partial failure, the provider can be live while a product page displays fallback variants, or vice versa. Sending a `demo:` variant to the live API will fail validation; adding a real variant to a demo bag can present misleading checkout expectations.

Decided 14 October 2026: production outages show an explicit store-unavailable experience, never demonstration merchandise (`lib/shopify.ts`, `app/error.tsx`).

## Further gaps

No custom `app/error.tsx` or route loading UI is present. Cart mutation warnings are returned but not displayed. An expired cart encountered during a later mutation does not automatically create a replacement. Live cross-tab state is not synchronized. Rate limits require a wait but the client does not implement a `Retry-After` countdown.

## Requirements for new failure paths

- Preserve meaningful user actions where possible and explain recoverable errors clearly.
- Do not expose upstream credentials, stack traces, cart keys, or customer data.
- Do not replace a failed backend operation with a success message.
- Distinguish validation errors, authentication/authorization failures, unavailable services, and unexpected errors in any new endpoint.
- Document retry semantics and avoid blindly replaying state-changing requests.
- Verify loading, empty, unavailable, and error states with keyboard and screen-reader announcements.
