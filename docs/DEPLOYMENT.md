# Chaanavya Deployment Procedure

## Current setup

The repository contains Vercel project linkage locally and a tracked `vercel.json` declaring `framework: nextjs`. No deployment URL, active production revision, CI pipeline, or hosting dashboard settings were verified during documentation authoring. `chaanavya.in` is the configured metadata base, not proof of an active deployment.

## Preflight

1. Identify the intended revision and environment. Review repository status and the diff.
2. Confirm hosting is configured for this Next.js project and uses a Node runtime satisfying the package requirement.
3. Configure domain, Storefront token, and supported API version privately in the correct environment scope. Set `SHOPIFY_USE_MOCK=false` in production.
4. Confirm published catalog, availability, currencies, shipping, taxes, and payment methods with the store operator.
5. Run the relevant checks and acceptance scenarios in `TESTING.md`.

```powershell
npm ci
npm run lint
npm run typecheck
npm run build
```

There is no `npm test` command. Builds load Google fonts and may require network access. Do not interpret a blocked dependency or font fetch as a successfully validated build.

## Proposed release sequence

Use the team's selected deployment workflow; none is documented as an existing CI process. First create a preview deployment through the configured hosting workflow, test it, then promote the verified revision through the owner's authorized release process. These steps do not authorize a deployment by themselves.

Record revision, deployment identifier/URL, environment, checks, changed configuration, responsible operator, and rollback target. Keep tokens and complete checkout/cart identifiers out of the record.

## Preview and production smoke tests

- Open the home page, each collection, a real product, support pages, and an invalid URL.
- Confirm metadata, favicon, social image, image loading, and approved branding.
- Confirm the catalog is real, not built-in fallback or external mock.
- Select an available variant; add, change quantity, remove, and restore after reload.
- Verify an HTTPS checkout handoff with the intended cart. Complete purchases only under an explicitly approved testing arrangement.
- Check production CSP, nonce behavior, security headers, mobile navigation, search, and overlays.
- Check the Contact and Track order links (email, WhatsApp, Shopify customer accounts) open the right destinations.
- Confirm configured monitoring and platform abuse protection are active.

## Launch blockers requiring a decision or verification

- Placeholder identity, support contacts, policy dates, shipping charges, delivery times, refund timing, and jurisdiction.
- Organic cotton versus broader boutique positioning and unverified product/material claims.
- Live Shopify settings and policy references to Razorpay; there is no direct Razorpay integration here.
- Size guide says measurements are taken flat while the caption calls them body measurements; confirm interpretation and values.
- Catalog/purchase mode consistency during partial failures, product and variant pagination limits. (Production no longer shows demo products during an outage.)
- Backend support services, or an explicit choice to retain accurate preview limitations.
- Production-wide rate controls, alert recipients, and rollback access.

## Rollback procedure

Proposed runbook: identify the last verified deployment, restore it through the hosting platform, restore compatible environment settings if they changed, and rerun catalog/cart/header smoke tests. If credentials were exposed, rotate them rather than restoring compromised values.

A storefront rollback does not reverse Shopify orders, payments, product edits, or external service changes. Handle those through their owning service and responsible operator. No local database migration rollback exists because there is no application database.

## Ongoing maintenance

Verify Storefront API compatibility before changing its configured version. Change cache, CSP, or rendering policy with dedicated smoke checks. Update `ENVIRONMENT.md`, `API.md`, `SECURITY.md`, and the changelog when release behavior changes.
