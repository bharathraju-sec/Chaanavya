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

## Server-side catalog operations

`lib/shopify.ts` sends POST requests to `https://<configured-domain>/api/<configured-version>/graphql.json` with `X-Shopify-Storefront-Access-Token`. Default version in code and the example is `2026-10`; compatibility has not been verified here.

`getProducts()` requests up to 50 newest products. `getProduct(handle)` validates an alphanumeric/hyphen handle up to 255 characters and fetches one product. Both return `{ products, live }` or `{ product, live }` and fall back on missing configuration or errors. Catalog calls cache for 300 seconds; cart calls do not cache. All upstream fetches have an eight-second timeout.

## Chat endpoint

`POST /api/chat` accepts `{ "messages": [{ "role": "user" | "assistant", "content": "..." }] }` and streams plain UTF-8 text. It requires a same-origin Fetch Metadata header or an Origin matching the request host; missing both is rejected. Message history must alternate user/assistant roles, start and end with a user message, and contain no more than 30 entries; only up to the last 12 are sent upstream. Requests are limited to 16,000 bytes, messages to 1,000 characters, and a 10-request-per-minute in-memory per-IP limit per function instance applies. It uses the live Shopify catalog as context only when available; fallback/demo products are never sent. `AI_GATEWAY_API_KEY` must be explicitly configured before a model request can run; the model defaults to `openai/gpt-5.4-mini` and can be changed with `AI_GATEWAY_MODEL`. The endpoint sends requests to Vercel AI Gateway and streams the model's text response. It does not persist chat history. The upstream request sends `model`, `messages`, `stream` and documented `reasoning: { effort: "low" }`; it leaves sampling and token-cap parameters at provider defaults to avoid model-specific behavior, so answer length is guided by the system prompt.

Questions about an existing order (for example "my order", "track my parcel", "shipment status", or "where is my package") are handled locally with a link to Shopify customer accounts; a bare shipping question (for example "do you ship to Pune?") goes to the assistant instead. The endpoint does not query customer or order records. Common email, phone-like number, and order-reference patterns are redacted from chat history before model submission; this is best-effort filtering, not a guarantee that all sensitive information is removed. Assistant product and help-page links use text markers that the client resolves only against the live product paths and fixed internal page allowlist; arbitrary model URLs are not rendered as links.

Explicit route errors use `{ "error": "..." }` with `Cache-Control: no-store`: 400 invalid messages, 403 origin rejected, 413 body too large, 415 unsupported content type, 429 rate limited, 503 missing gateway credentials, and 502 upstream unavailable. Successful responses use `text/plain; charset=utf-8` and `Cache-Control: no-store, no-transform`.

## Other absent endpoints

There are no contact delivery, newsletter subscribe, order lookup, customer login, payment capture, webhook, or cache invalidation endpoints. Adding them requires a documented input/output contract, authorization rules, failure behavior, and verification.
