# Chaanavya API Contracts

## Local endpoint

`POST /api/shopify` is a same-origin JSON endpoint for allowlisted cart operations. It does not accept browser-supplied GraphQL queries, return catalog listings, or expose the configured token. Source: `app/api/shopify/route.ts`.

```json
{
  "action": "cartCreate",
  "variables": {
    "input": {
      "lines": [
        { "merchandiseId": "gid://shopify/ProductVariant/123456789", "quantity": 1 }
      ]
    }
  }
}
```

The ID is illustrative, not a real catalog fixture.

## Supported actions

| Action | Variables | Successful response root |
| --- | --- | --- |
| `cart` | `{ "id": "<cart GID>" }` | `{ "cart": <cart or null> }` |
| `cartCreate` | `{ "input": { "lines": [{ "merchandiseId": "<variant GID>", "quantity": 1 }] } }` | `{ "cartCreate": <mutation result> }` |
| `cartLinesAdd` | `{ "cartId": "<cart GID>", "lines": [{ "merchandiseId": "<variant GID>", "quantity": 1 }] }` | `{ "cartLinesAdd": <mutation result> }` |
| `cartLinesUpdate` | `{ "cartId": "<cart GID>", "lines": [{ "id": "<line GID>", "quantity": 2 }] }` | `{ "cartLinesUpdate": <mutation result> }` |
| `cartLinesRemove` | `{ "cartId": "<cart GID>", "lineIds": ["<line GID>"] }` | `{ "cartLinesRemove": <mutation result> }` |

Mutation result: `{ cart, userErrors: [{ field, message, code }], warnings: [{ code, message, target }] }`. Shopify user errors can be returned with HTTP 200. The client checks `userErrors` and cart presence; it does not currently display warnings.

Returned cart fields: `id`, `checkoutUrl`, `totalQuantity`, `cost.subtotalAmount`, `cost.totalAmount`, and `lines.nodes` with ID, quantity, variant data, price, and product title/handle/image. No generic `{data,error}` envelope is added by the local route.

## Validation

- Content type must start with `application/json`.
- Declared `Content-Length` above 8192 is rejected. The second limit compares decoded string length above 8192, not UTF-8 byte count; it is not a streaming byte limit.
- Action must exactly match an allowlisted operation; variables must be a non-array object.
- GIDs must start with `gid://shopify/Cart/`, `CartLine/`, or `ProductVariant/` as appropriate, contain no whitespace, and have at most 300 characters. Validation checks the prefix, not existence or ownership.
- Each supplied line list must contain 1 to 20 entries.
- Add/create quantities must be integers from 1 to 99; update quantities from 0 to 99.
- Validators copy only expected fields. Arbitrary buyer identity, attributes, discounts, and extra GraphQL parameters are not passed through.

## Request protections

When `sec-fetch-site` is present, only `same-origin` is accepted. Otherwise Origin is compared to Host or forwarded Host; requests without either browser origin hint are allowed. This is browser-origin filtering, not user authentication.

The in-memory limiter allows 60 requests per IP per 60-second window on each function instance. Excess returns `Retry-After`. Counts are not shared between instances; hosting-level controls must be verified independently.

## Status codes

| Status | Meaning |
| --- | --- |
| 200 | Upstream data, including possible mutation user errors |
| 400 | Invalid JSON, unsupported operation, or invalid variables |
| 403 | Origin filtering rejected the request |
| 405 | GET rejected with `Allow: POST`; other unsupported methods use framework handling |
| 413 | Declared size or decoded text length exceeds the limit |
| 415 | Unsupported content type |
| 429 | Per-instance rate limit reached |
| 500 | Shopify configuration throws validation error |
| 502 | Upstream fetch, timeout, transport, or Storefront error |
| 503 | Shopify configuration is absent |

Explicit route errors have `{ "error": "<message>" }`; explicit responses use `Cache-Control: no-store`. Clients must check both HTTP status and mutation user errors.

## Newsletter signup

`POST /api/marketing/subscribe` accepts `{ "email": "...", "marketingConsent": true, "campaign": "welcome-popup-v1", "consentTextVersion": "2026-10" }` from the welcome popup. Same-origin only, 2 KB body cap, 5 requests per minute per IP per function instance. The server trims and lowercases the email, requires explicit consent and the current campaign and consent-text version, then creates a Shopify customer with `emailMarketingConsent` SUBSCRIBED (single opt-in, tags `newsletter` and the campaign) through the Admin API, or updates consent on an existing customer. New and existing addresses get the same `200 { "status": "subscribed" }`. Errors: 400 invalid email/consent/request, 403 origin, 413 size, 415 content type, 429 rate limited (`Retry-After`), 503 when Shopify Admin credentials are not configured, 502 provider failure. Email addresses and provider bodies are never logged.

## Server-side catalog operations

`lib/shopify.ts` sends POST requests to `https://<configured-domain>/api/<configured-version>/graphql.json` with `X-Shopify-Storefront-Access-Token`. Default version in code and the example is `2026-10`; compatibility has not been verified here.

`getProducts()` requests up to 50 newest products. `getProduct(handle)` validates an alphanumeric/hyphen handle up to 255 characters and fetches one product. Both return `{ products, live }` or `{ product, live }` and fall back on missing configuration or errors. Catalog calls cache for 300 seconds; cart calls do not cache. All upstream fetches have an eight-second timeout.

## Absent endpoints

There are no contact delivery, newsletter subscribe, order lookup, customer login, payment capture, webhook, or cache invalidation endpoints. Adding them requires a documented input/output contract, authorization rules, failure behavior, and verification.
