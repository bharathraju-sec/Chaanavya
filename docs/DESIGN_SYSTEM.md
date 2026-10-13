# Chaanavya Design System

## Authority and direction

The existing [design master](../design-system/chaanavya/MASTER.md) is the visual authority. Page-specific files under `design-system/chaanavya/pages/`, if added, override the master for that page. None were present at the documentation baseline. This document maps that direction to code; it does not replace the master.

Use warm editorial layouts with an ivory background, deep teal typography, terracotta actions, and restrained gold details. Keep generous space, square corners, and hairline separation. Do not add dark mode, gradients, glass effects, card shadows, or a new visual identity without an explicit design change.

## Tokens in the implementation

Tokens are defined in `app/globals.css`. Use semantic or brand Tailwind classes instead of repeating raw colors in components.

| Token | Value | Use |
| --- | --- | --- |
| paper / background | `#FBF7F0` | Page background |
| sand / secondary | `#F3ECDF` | Alternate sections and footer |
| well / muted | `#ECE3D3` | Image wells and muted surfaces |
| card | `#FFFFFF` | Form surfaces |
| ink / foreground / primary | `#073F40` | Text and dark sections |
| muted-foreground | `#56625E` | Secondary copy |
| line / border | `#E2D7C5` | Hairline separators |
| line-strong / input | `#C9BBA3` | Input and outline boundaries |
| gold | `#B8893E` | Decorative elements |
| gold-text | `#8A6420` | Labels on light surfaces |
| gold-on-dark | `#D9B26A` | Labels on teal surfaces |
| terra / ring | `#A8461F` | Primary buttons and focus outlines |
| terra-hover | `#8E3A19` | Primary button hover |
| on-dark | `#F6F0E4` | Text on dark surfaces |
| on-dark-muted | `#C9D3CF` | Secondary text on dark surfaces |
| destructive | `#B42318` | Error semantics |

Known difference: the master describes terra as `bg-accent`, but CSS maps `accent` to sand. Use `bg-terra` for terracotta actions; reconcile the alias deliberately if changing the theme.

## Typography and layout

- Cormorant is the display serif; Montserrat is the body and interface font. `app/layout.tsx` loads both through `next/font/google`.
- Body text defaults to 16px with relaxed leading. Keep sustained body text at least 13px. Smaller uppercase eyebrows and compact labels are secondary roles.
- Use balanced headings with responsive `clamp()` sizes. Do not apply one fixed display size to every screen.
- `page-wrap` sets a 1440px maximum width and `clamp(16px, 4vw, 56px)` side gutters.
- `section-y` uses `clamp(64px, 9vw, 128px)` vertical space.
- All radius tokens are zero. Round heart controls and bag counters are exceptions.
- Navigation switches at 901px. Product grids use two mobile columns, three at `md`, and optionally four at `lg`; most editorial layouts split at `md`.

## Reusable components

| Component | Rules |
| --- | --- |
| `components/ui/button.tsx` | Existing `default`, `outline`, `quiet`, `light`, `ghost`, and `link` variants; standard 48px height |
| Product card | 4:5 image well, overlaid wishlist, serif title, description, price, and aligned quick add |
| Bag | Right-side Radix Sheet; subtotal and checkout remain at the bottom |
| Mobile menu | Left-side Sheet with active-page indication |
| Search and quick add | Radix Dialogs with titles, keyboard operation, and scrollable content |
| Option picker | Single-select ToggleGroups per option; unavailable combinations disabled |
| Support pages | `SupportPage`, `PolicySection`, and shared field primitives |
| Notifications | Sonner toast through `components/ui/sonner.tsx` |

Use Lucide icons with an accessible button label and decorative icons hidden from assistive technology. Preserve the project's logo assets.

## Motion

Use restrained color transitions and image zoom to 1.03. The master specifies 180ms hover color changes; current buttons use 200ms. `Reveal` applies a 14px rise only below the fold. CSS and the component honor reduced motion. Keep content visible in server HTML and when observer support is absent. No marquees, parallax, cursor effects, or looping animation.

## Accessibility requirements

- Visible 2px terracotta focus outline with 3px offset; verify component overrides do not suppress it.
- At least 44px interactive targets and sufficient contrast for the actual rendered state.
- Semantic headings, labelled controls, descriptive dialog titles, and usable keyboard navigation.
- Preserve the skip link, dialog focus management, and `aria-pressed` wishlist state.
- Verify at 375, 768, 1024, and 1440px without unintended horizontal scrolling.

These are requirements, not a completed accessibility audit. Bag quantity buttons currently use `size-9` (36px), which needs review against the 44px target.

## Content requirements

Do not invent reviews, performance counters, bestsellers, discounts, material claims, or sustainability claims. Existing editorial slogans and stock imagery are template material awaiting owner review. Avoid em dashes in storefront copy; do not use emoji icons or AI-generated stock imagery, as recorded in the master.

Approved product photography, brand positioning, palette contrast validation, and fit guidance remain launch checks.
