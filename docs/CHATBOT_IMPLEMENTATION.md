# Chatbot Implementation Brief

Use this brief to implement or review the Chaanavya storefront chatbot. Read `docs/AGENTS.md`, `docs/PRD.md`, `docs/API.md`, `docs/SECURITY.md`, `docs/ERROR_HANDLING.md`, `docs/DESIGN_SYSTEM.md`, and `design-system/chaanavya/MASTER.md` first. Inspect the current working tree and chatbot files before editing. Reuse existing work and fix gaps; do not create a second chatbot or overwrite unrelated changes.

## Goal

Add a site-wide shopping assistant that helps customers:

1. Discover products and get basic store information.
2. Get order/account help through Shopify customer accounts.
3. Reach a person through the existing support email or WhatsApp links.

The chatbot is a support and discovery feature. Shopify remains the source of truth for products, carts, checkout, customer accounts, and orders.

## Customer experience

- Add a persistent, clearly labelled “Ask Chaanavya” launcher and a right-side chat drawer that works at 375px and larger widths.
- Start with a short explanation and suggested prompts for product discovery, sizing, and order support.
- Stream assistant replies as they arrive. Show a clear loading state, recoverable error state, and a way to start a new chat.
- Provide a labelled message field and send button. Enter sends; Shift+Enter adds a line. Preserve typed input while a reply is streaming.
- Keep “My orders,” email support, and WhatsApp visible. Group secondary links such as size, shipping, and returns under an accessible disclosure.
- Show an honest disclosure that messages go to an AI provider, explain that the storefront does not store chat history, and link to the privacy policy. Tell shoppers not to enter passwords, OTPs, payment details, or sensitive personal information.
- Keep chat history in the current page session only. A “New chat” action clears it. Do not add local storage or a database.

## Product and policy answers

- Only send live Shopify products to the model. If the catalog is unavailable or in demo mode, send no products and do not repeat demo names, prices, imagery, or stock claims.
- Supply product title, exact storefront path, current price, variant options, and availability. Recommend only products with an available variant. Do not invent fit, materials, discounts, delivery promises, or other claims.
- Render product links from a strict allowlist of paths supplied by the server. Treat model output and catalog descriptions as untrusted text. Do not render arbitrary HTML or external links from the model.
- Keep shipping, return, and legal answers brief and link customers to the corresponding approved site page instead of inventing or paraphrasing business terms.

## Order help and human handoff

- This implementation does not authenticate customers or query Shopify order records.
- For order status, shipment, or tracking requests, respond with the Shopify customer account link. Do not ask for or submit an order number, email, phone number, or address.
- Do not implement phone OTP, customer account creation, Admin API access, order lookup, or custom checkout as part of this chatbot task.
- Email and WhatsApp handoff should open the already configured support destinations. Do not claim that a message was sent by the website.

## Server and AI provider

- Keep AI credentials on the server. Require an explicitly configured `AI_GATEWAY_API_KEY`; do not expose it in a `NEXT_PUBLIC_*` variable or browser bundle. Do not silently enable model requests through an ambient deployment token.
- Use Vercel AI Gateway with the configured model (`AI_GATEWAY_MODEL`, default `openai/gpt-5.4-mini`) unless the owner approves another provider. Avoid adding a dependency when the existing server-side HTTP integration is sufficient.
- Validate same-origin requests, JSON shape, message roles, message length, total body size, and history length. Apply a per-instance abuse limit and document that it is not distributed; configure platform-wide limits before production use.
- Stream plain text to the client. Never return provider diagnostics, prompts, credentials, or raw upstream error bodies. Do not log chat text or personal information.
- Apply best-effort filtering for common email, phone-like, and order-reference values before model submission. Clearly document that pattern matching cannot guarantee removal of all sensitive information.
- If credentials are absent or the provider fails, return a generic, actionable error and leave the contact links available.

## Design and accessibility

- Follow the warm editorial authority in `design-system/chaanavya/MASTER.md`: paper, sand, ink, muted, terra, and gold-text tokens; existing Cormorant/Montserrat typography; square corners; Lucide icons; no gradients or emoji icons.
- Use semantic buttons, links, a labelled textarea, visible focus styles, and touch targets at least 44px tall. Preserve the page's existing focus behavior when the drawer closes.
- Make the transcript a scrollable, `min-h-0` flex region. Follow new replies while the customer is at the bottom, but do not force-scroll when they read older messages.
- Avoid announcing every streamed token to assistive technology. Use a concise polite status announcement when a reply starts and finishes, and keep the transcript navigable.
- Respect reduced motion, mobile safe areas, text scaling, and keyboard use. Avoid content being hidden behind the fixed launcher or composer.

## Configuration and privacy before production

- Add only variable names and safe defaults to `.env.example`. Never inspect or print `.env.local` values.
- The model endpoint must remain unavailable until `AI_GATEWAY_API_KEY` is deliberately configured.
- Before production enablement, the owner must confirm provider terms and retention behavior, add an accurate disclosure to the privacy policy, configure platform-wide abuse controls, and verify the production environment.
- Do not deploy or make the chatbot live as part of an implementation-only task.

## Documentation and acceptance

Update `docs/API.md`, `docs/SECURITY.md`, `docs/ERROR_HANDLING.md`, `docs/PRD.md`, `docs/DECISIONS.md`, and `docs/CHANGELOG.md` when implementation details or contracts change. Add this brief to `docs/README.md`.

The implementation is ready for review when:

- Product discovery uses only live catalog data and links to real product routes.
- Order questions go to Shopify customer accounts without exposing order data.
- Email and WhatsApp provide an obvious human handoff.
- Loading, streaming, unavailable, error, and new-chat states are understandable.
- Keyboard and screen-reader use work without token-by-token announcements.
- Mobile layout has no horizontal overflow and the composer remains usable with the on-screen keyboard.
- The provider credential remains server-only and the feature is inactive without explicit configuration.
- Lint, type checking, and build have been run where the environment allows; failures and unverified browser/Shopify behavior are reported accurately.
