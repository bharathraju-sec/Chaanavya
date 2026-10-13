# Chaanavya User Flows

These journeys describe the current storefront. Future support integrations are identified separately. Route and component references are relative to the repository root.

## Browse and discover

1. Shopper opens `/` and sees editorial collection links and the first four loaded products.
2. Shopper chooses a collection through the hero, navigation, tiles, or footer.
3. `app/[collection]/page.tsx` resolves one of the five configured slugs and filters the loaded catalog.
4. Shopper opens a product by its image or title.

Success: the correct product page loads with its details. Empty collection: `ProductGrid` shows a message. Unknown collection or missing product: not-found page. Shopify read failure: demonstration catalog can replace the live catalog; see the mode caveat in `ERROR_HANDLING.md`.

## Search

1. Shopper opens the header search dialog.
2. Empty query shows the first eight combined navigation and product entries.
3. A trimmed, case-insensitive query filters labels and displays up to 12 matches.
4. Shopper follows a result; the dialog closes. Closing the dialog clears its query.

No matches displays `No matches yet.` Search is not a Shopify query and is not full-catalog search beyond the 50 loaded products. It does not match descriptions, SKUs, or all tags.

## Select a variant and add

1. Shopper opens product details or quick add.
2. Single-value options are preselected and hidden; options with multiple values require a choice.
3. The picker disables values with no available variant matching the other selected options.
4. Add remains disabled until an available variant is resolved.
5. During the mutation, purchase controls using the shared `busy` flag are disabled.
6. On success, a toast offers `View bag`. Quick-add dialog closes after success.

Products with no real choice can be added directly from quick add. Sold-out products show `Currently unavailable`. Shopify user errors appear as a toast; failed adds leave the quick-add dialog open.

## Bag and checkout

1. First live add calls `cartCreate`; subsequent adds call `cartLinesAdd`.
2. The app stores the returned cart ID in browser local storage.
3. Shopper opens the right-side bag Sheet, changes quantity, or removes a line.
4. Shopify returns updated lines and subtotal. Quantity zero in the UI uses removal.
5. Checkout is enabled only with lines, an HTTPS checkout URL, and no pending operation.
6. Clicking checkout navigates away to the URL supplied by Shopify.

Shipping and taxes are calculated at checkout. There is no order confirmation route or payment form in this repository. Checkout completion and payment methods must be verified in Shopify separately.

## Restore a bag

On a live-mode mount, `CartProvider` reads the stored cart ID and requests `cart`. A returned cart restores the bag. A missing cart or any request failure removes the saved ID. A temporary network failure therefore loses the restoration reference; a differentiated retry flow is proposed, not implemented.

Live cart React state does not subscribe to cross-tab cart updates. Demo cart and wishlist subscribe to browser storage and custom events. No cart merge or demo-to-live conversion exists.

## Demonstration mode

When the root layout's catalog read returns `live: false`, demo additions are persisted locally and the subtotal is computed locally in INR. Checkout stays disabled. External mock configuration is different: a successful mock read can set `live: true`, so it must be confined to non-production testing.

## Wishlist

Shopper toggles the heart on a card or product detail. Product handles are stored locally and the pressed state updates. A toast announces the change. There is no standalone wishlist page or server-side synchronization. Storage denial can prevent persistence; malformed stored data needs explicit verification.

## Support

| Journey | Inputs | Current result |
| --- | --- | --- |
| Contact | Name, email, topic, message | Browser validation followed by a preparation message; no delivery |
| Track order | None on this site | Links to Shopify customer accounts for status and tracking, plus email/WhatsApp help |

Launch requirement: choose integrations and return success only after backend confirmation, or clearly retain preview behavior. Order tracking must not reveal customer data based solely on an easily guessed order reference.

## Journey validation

Test with keyboard and touch, reduced motion, empty collections, missing images, multi-option products, sold-out variants, denied storage, expired cart IDs, network errors, and small screens. Record actual outcomes with `TESTING.md`; this document does not claim those scenarios have passed.
