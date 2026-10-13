# Chaanavya Documentation

This documentation describes the storefront in this repository and provides requirements for completing and maintaining it. Baseline: 13 October 2026; package version: `2.0.0`. It was written from source inspection. It does not establish that a live deployment, Shopify store, or payment setup has been tested.

## How to read these documents

- **Current behavior** describes checked-in code.
- **Requirement** describes behavior to preserve or achieve, with unfinished items stated explicitly.
- **Proposed** identifies a suggested next step that has not been implemented or scheduled.
- **Open question** identifies a business or operational decision the repository cannot establish.

The guide supplied by the owner informed the document structure. Its example prompts are reference material, not instructions to execute against this application.

| Document | Purpose |
| --- | --- |
| [PRD.md](PRD.md) | Product scope, users, acceptance criteria, and open decisions |
| [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) | Visual authority, tokens, components, and accessibility |
| [UX_FLOWS.md](UX_FLOWS.md) | Browsing, selection, bag, checkout, search, and support journeys |
| [ARCHITECTURE.md](ARCHITECTURE.md) | System boundaries, rendering, caching, and project structure |
| [DATABASE.md](DATABASE.md) | Shopify data model and browser persistence; no local database |
| [API.md](API.md) | The local cart endpoint and server-side Shopify operations |
| [CHATBOT_IMPLEMENTATION.md](CHATBOT_IMPLEMENTATION.md) | Chatbot scope, security boundaries, UI behavior, and acceptance criteria |
| [SECURITY.md](SECURITY.md) | Implemented protections, trust boundaries, and remaining checks |
| [CODE_STYLE.md](CODE_STYLE.md) | TypeScript, component, styling, and dependency conventions |
| [TESTING.md](TESTING.md) | Existing checks and reproducible manual acceptance scenarios |
| [AGENTS.md](AGENTS.md) | Instructions for future coding work |
| [ENVIRONMENT.md](ENVIRONMENT.md) | Configuration names, modes, and local setup |
| [ERROR_HANDLING.md](ERROR_HANDLING.md) | Failure behavior, status codes, and recovery gaps |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Build, release, smoke tests, and rollback procedure |
| [OBSERVABILITY.md](OBSERVABILITY.md) | Current logging and proposed production signals |
| [DECISIONS.md](DECISIONS.md) | Existing technical choices and their tradeoffs |
| [ROADMAP.md](ROADMAP.md) | Proposed priorities and unresolved scope |
| [CHANGELOG.md](CHANGELOG.md) | Source history baseline and documentation changes |

## Sources of truth

Product scope is recorded in the PRD; API and persistence contracts live in their dedicated documents. The design master at `design-system/chaanavya/MASTER.md` remains the authority for visual decisions; CSS records the tokens actually rendered. If code differs from an intended rule, record the gap and resolve it explicitly. Do not silently rewrite requirements to match a defect.

Update the relevant document in the same change that alters behavior or contracts. Record important tradeoffs in `DECISIONS.md` and meaningful changes in `CHANGELOG.md`. Keep roadmap proposals separate from commitments.

## Known launch gaps

1. Live catalog, stock, variants, shipping, tax, payment configuration, and checkout have not been verified by this documentation task.
2. There is no newsletter sign-up (removed until an email service is chosen). Contact links to email and WhatsApp; Track order links to Shopify customer accounts (not yet verified with a real order).
3. All four policy pages (Terms 12 October 2026; Return & Refund, Privacy and Shipping 13 October 2026) are owner-supplied. The Terms name a role (Customer Support, Chaanavya) as grievance contact rather than a person. Shopify still ships internationally (28 countries) although the Shipping Policy says India only.
4. Metadata and logo alternative text refer to organic cotton clothing, while storefront copy describes a broader regal fashion boutique. The final positioning is unresolved.
5. Live collection membership is inferred from titles, types, and tags; Shopify collection membership is not fetched. Catalog pagination is absent.
6. No automated tests, checked-in CI workflow, or application monitoring integration was found.
7. Mock mode is blocked only when `VERCEL_ENV=production`; that is not a general production guard for other hosts.
8. Root layout catalog status and individual page catalog reads can disagree during a partial failure. Mode consistency needs validation.
9. Application rate limiting is per instance. A platform-wide limit is referenced in code comments but its deployed configuration is not verified.
