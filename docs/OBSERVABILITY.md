# Chaanavya Observability

## Current instrumentation

`lib/shopify.ts` logs Storefront API error details or HTTP status. The cart route logs configuration and network errors. Browser notifications describe cart outcomes. No dedicated error tracker, analytics client, application metrics exporter, alert configuration, or performance dashboard integration was found.

Vercel configuration alone does not establish active log retention, alerts, firewall rules, or monitoring. Existing console output can include raw upstream errors and requires review before relying on it for production diagnostics.

## Proposed production signals

| Signal | Why it matters | Suggested event or measurement |
| --- | --- | --- |
| Catalog fallback | Successful HTML can conceal a store outage | Count missing-config and upstream-error fallback separately |
| Shopify latency/failure | Measures commerce dependency health | Operation name, duration, status category, timeout count |
| Cart mutation outcome | Directly affects purchase ability | Success, transport failure, user-error code, warning code |
| Checkout handoff | Confirms transition from storefront to commerce | Handoff attempted with a valid destination; do not call this payment completion |
| Page/route failure | Detects broken browsing | Route category, not-found rate, unhandled exceptions |
| API rejection | Finds abuse and contract regressions | Counts for 400, 403, 413, 415, 429, and upstream 5xx |
| Future support submission | Detects delivery failures | Backend-confirmed submission outcome, without message content |

All entries are proposed; they are not presently collected as application metrics. Confirm consent and analytics requirements before adding shopper event collection. Payment completion should be measured through an authoritative Shopify mechanism, not a checkout click.

## Logging requirements

Log operation names, coarse error categories, durations, revision, and non-sensitive correlation IDs. Redact tokens, full cart IDs and keys, checkout secrets, customer email, addresses, order identifiers when sensitive, and form contents. Do not dump requests or environment files. Bound and sanitize upstream error output.

## Alerts and ownership

Before launch, choose an alert recipient and escalation path. Proposed triggers are sustained catalog fallback, repeated cart upstream failure, unavailable pages, and a material increase in API rejections. Thresholds and response times are owner/maintainer decisions; no invented service-level commitment applies.

## Incident workflow

1. Confirm the affected environment, revision, and mode.
2. Determine whether the issue is frontend, configuration, Shopify transport, or Shopify business validation.
3. Inspect sanitized logs and reproduce with controlled data.
4. If release-related, use the rollback procedure in `DEPLOYMENT.md`.
5. Verify browsing, bag, and checkout handoff after recovery.
6. Record the cause, fix, and relevant documentation update.

Do not treat fallback pages returning HTTP 200 as proof that commerce is healthy.
