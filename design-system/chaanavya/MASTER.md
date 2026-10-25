# Chaanavya Design System (Master)

> When building a page, first check `design-system/chaanavya/pages/<page>.md`.
> If it exists, its rules override this file. Otherwise follow this file.

Generated with the ui-ux-pro-max skill (2026-10-13), then corrected by hand to the
direction the owner approved: **warm editorial**. The skill's automatic pick
("Liquid Glass", stone black and gold) was rejected because it does not match the logo.

- **Product:** E-commerce, women's fashion boutique (India, INR)
- **Dials:** Variance 4/10 (balanced), Motion 6/10 (standard, approved by the owner on 25 October 2026), Density 3/10 (spacious)
- **Stack:** Next.js 16 App Router, React 19, Tailwind CSS 4, shadcn/ui, lucide-react

---

## Colour tokens

Taken from the logo (deep teal, gold, terracotta) on an ivory page. Defined once in
`app/globals.css`; components use the Tailwind names, never raw hex.

| Token | Hex | Tailwind | Use |
|---|---|---|---|
| paper | `#FBF7F0` | `bg-paper` / `bg-background` | Page background |
| sand | `#F3ECDF` | `bg-sand` | Alternate sections, footer |
| well | `#ECE3D3` | `bg-well` / `bg-muted` | Image placeholders, disabled |
| surface | `#FFFFFF` | `bg-card` | Forms, cards |
| ink | `#073F40` | `text-ink` / `text-foreground` / `bg-primary` | Text, dark sections |
| muted | `#56625E` | `text-muted-foreground` | Secondary text (5.9:1 on paper) |
| line | `#E2D7C5` | `border-line` / `border-border` | Hairlines |
| line-strong | `#C9BBA3` | `border-line-strong` | Inputs, outlines |
| gold | `#B8893E` | `bg-gold` | Decorative rules only, never small text on light |
| gold-text | `#8A6420` | `text-gold-text` | Eyebrow labels on light (5.0:1) |
| gold-on-dark | `#D9B26A` | `text-gold-on-dark` | Eyebrow labels on ink (5.8:1) |
| terra | `#A8461F` | `bg-terra` / `bg-accent` | Primary action buttons, bag count (white text 5.9:1) |
| terra-hover | `#8E3A19` | `bg-terra-hover` | Hover for terra |

No dark mode: the brand is ivory-first. No gradients (purple gradients are banned).

## Typography

- **Display:** Cormorant (500 for headings, italic 400 for the footer line). Loaded with `next/font`.
- **Body / UI:** Montserrat 400, 500, 600.
- Base 16px, line-height 1.6. Never body text below 13px.
- Eyebrows: Montserrat 600, 11px, `tracking-[0.18em]`, uppercase, gold-text.
- Buttons and nav: Montserrat 500 to 600, 12px, `tracking-[0.14em]`, uppercase.
- Headings use `text-balance`; display sizes use `clamp()`.

## Shape, depth, spacing

- Square corners everywhere (`rounded-none`); only the heart button and bag count are circles.
- No shadows on cards. Separation comes from hairlines and background changes.
- Page gutter `clamp(16px, 4vw, 56px)`, max width 1440px, section padding `clamp(64px, 9vw, 128px)`.

## Components

- **Button primary:** terra fill, white text, 48px min height, uppercase label, arrow icon nudges 3px on hover.
- **Button outline:** 1px ink border, fills ink on hover. **Light:** ivory fill on ink sections.
- **Text link:** uppercase label, 1px underline offset 7px, arrow icon.
- **Product card:** 4:5 image well, heart (aria-pressed) top right, optional tag top left,
  title (Cormorant 21px) and details left, price right, full-width "Quick add" outline button aligned at the bottom.
- **Cart:** shadcn `Sheet` from the right. **Size picker and search:** shadcn `Dialog`. **Mobile nav:** `Sheet` from the left.
- Icons: lucide-react, stroke 1.5, 20px, always `aria-hidden` with a labelled button.

## Motion

**2026 redesign, approved by the owner on 25 October 2026 (Motion 13.5.1; the dial moved from 3/10 to 6/10).**
Shared pieces live in `components/motion/motion.tsx`; the storefront is wrapped in `MotionConfig reducedMotion="user"`.

- One rhythm: arrivals decelerate on `cubic-bezier(.22,1,.36,1)` (0.6 to 0.9s); presses and indicators use a spring (stiffness 380, damping 32).
- Hero: the display headline rises out of a mask line by line; the hero photo settles from 1.06 and drifts up to 8% slower than the page. The hero photo is never hidden (largest paint).
- Sections and grids: headings rise 22px into place; grid items stagger about 70ms apart; editorial photos uncover with a bottom-edge wipe. Once only, never on scroll back.
- Header: slides away while scrolling down past 240px, returns on scroll up and whenever focus enters it. The desktop nav underline glides between items and rests on the current page.
- Product: the size choice fill and the gallery thumbnail ring slide to the new choice; a second product photo crossfades in on hover (pointer devices only).
- Information and policy pages: a sand header band (gold-rule eyebrow, title rising out of a mask, lead fading in); policy pages add a sticky "On this page" list on wide screens whose terra marker slides to the section being read; contact and help cards draw their gold rule out on hover.
- Account, sign-in and 404 use the same header motion; sign-in shows an editorial photo beside the form on wide screens. Bag lines slide out when removed and the rest close up; the bag count pops when it changes.
- Content at the top of a page (eyebrows, mask headlines, first-paint staggers) animates with CSS keyframes in `app/globals.css`, so it shows on first paint without waiting for JavaScript. Scroll reveals further down use Motion.
- Hover: colour 180 to 300ms; image zoom 1.04 to 1.05 over 900ms.
- Transform and opacity only (no layout animation). No marquees, cursor effects or looping animation. Under `prefers-reduced-motion` nothing moves.

Replaced rule (3/10, before 25 October 2026): hover colour 180ms, image zoom 1.03 over 600ms, scroll reveal opacity and 14px rise below the fold only, no parallax.

## Content rules (from the owner)

- No fake reviews, metrics, counters, "Bestseller" or discount badges.
- No em dashes; avoid en dashes in prose.
- No emoji as icons. No AI-generated stock imagery.
- Existing slogans are template leftovers: keep them, but they are flagged for the owner to replace.

## Pre-delivery checklist

- [ ] Text contrast 4.5:1 or better
- [ ] Visible focus ring (terra, 2px, offset 3px) on every control
- [ ] Touch targets 44px or larger
- [ ] Works at 375, 768, 1024, 1440px with no horizontal scroll
- [ ] `prefers-reduced-motion` respected
- [ ] Every icon-only button has an accessible label
- [ ] Images have width/height or an aspect-ratio box (no layout shift)
