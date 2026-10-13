# Chaanavya Code Conventions

## Existing style

Use TypeScript and React function components. Existing application files generally use double quotes, two-space indentation, and no semicolons; configuration files sometimes use semicolons. Match the file being edited. No Prettier configuration or formatter script is present, so do not claim a formatter is enforced.

TypeScript strict mode and the Next.js ESLint configuration are enabled. Use `@/` imports for project modules. Keep type-only imports explicit where appropriate. Name components in PascalCase, functions and variables in camelCase, and constants in uppercase when they represent fixed limits or keys. Component filenames generally use kebab-case.

## Placement and reuse

| Concern | Location |
| --- | --- |
| Route content and metadata | `app/<route>/page.tsx` |
| Cart transport endpoint | `app/api/shopify/route.ts` |
| Shopify server access | `lib/shopify.ts` |
| Shared product and money types | `lib/types.ts` |
| Collection taxonomy and matching | `lib/collections.ts` |
| Cart state and bag | `components/cart/` |
| Product interactions | `components/product/` |
| Site chrome, forms, support layouts | `components/site/` |
| Shared primitives | `components/ui/` |
| Design tokens | `app/globals.css` |

Prefer existing Button, Dialog, Sheet, ToggleGroup, Accordion, input, and layout primitives. Do not create duplicate cart providers, money formatters, or option matching logic. Avoid unrelated file changes and new dependencies unless the requirement needs them.

## Server and client rules

Keep routes and catalog reads on the server. Add `"use client"` only where browser APIs, state, effects, or event handlers require it. Never import Shopify environment access into a client component. Use context methods for cart operations. Preserve JSON-serializable values crossing the server/client boundary.

Use `useSyncExternalStore` for browser persistence subscriptions where already established, with stable snapshots and server fallbacks. Keep transient dialog state local. Validate restored data when modifying persistence code; TypeScript casts do not validate runtime values.

## Styling and accessibility

Follow `DESIGN_SYSTEM.md` and the existing master. Prefer reusable tokens, `cn`, responsive utilities, and established spacing. Keep image dimensions or aspect-ratio containers and accurate `sizes`. Use `next/link` for internal navigation and `next/image` for imagery.

Every icon-only control needs an accessible name. Preserve visible focus, semantic labels, disabled states, dialog titles, and reduced motion. New components must support the same keyboard and mobile journeys as existing primitives.

## Errors and logging

Check HTTP failure and Shopify mutation user errors separately. Preserve generic service errors at the server boundary, useful customer feedback, and busy-state cleanup in `finally`. Do not report success before a backend confirms it. Logging must exclude credentials, complete cart IDs, customer details, and raw request bodies.

## Comments and contracts

Comments should explain tradeoffs and non-obvious constraints, such as CSP rendering or per-instance rate limiting. Do not let a comment imply a deployed configuration that has not been checked. When changing limits or shapes, update types, handlers, UI, tests or acceptance scenarios, and the corresponding document.

## Validation commands

```powershell
npm run lint
npm run typecheck
npm run build
```

`typecheck` generates Next.js route types first. There is no `npm test`. Add focused tests when introducing meaningful business logic or fixing behavior, and document the chosen runner before advertising new test commands.
