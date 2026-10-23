# Stage 06 evidence: admin dashboard shell, permissions and audit trail

Captured 16 October 2026 in the upgrade workspace `backup/upgrade` (based on main `60ea71a`, which is untouched). Also in this stage, at the owner's request: the admin on its own host, a header Sign in button on every storefront page, and the removal of Shopify (decisions 029 and 031).

## Deliverables

| Path | Contents |
| --- | --- |
| `app/admin/(entry)/`, `app/admin/(workspace)/` | Login, MFA setup, overview, audit trail, settings, eight planned-section pages, loading and error states, admin 404 |
| `components/admin/` | Shell, navigation, page blocks and empty states, audit table, login and MFA forms, team manager |
| `lib/admin/` | API conventions (envelopes, cursors, reasons, ETags), host routing, navigation, audit queries, staff views |
| `lib/auth/permissions.ts`, `lib/auth/guards.ts`, `lib/auth/staff.ts` | Page and API gates, refund limits (proposed threshold), transactional staff changes with audit |
| `lib/modules/audit/catalogue.ts` | Canonical admin audit rules and `recordAdminEvent` |
| `app/api/admin/` | Staff list and detail, grant and revoke role, deactivate, sign out everywhere, settings, audit |
| `proxy.ts`, `lib/config/env.ts` | Admin host routing, `noindex`, `ADMIN_URL` rules |
| `scripts/admin-user.mjs` | `admin:bootstrap-owner`, `admin:add-staff` |
| `components/site/header.tsx`, `app/(store)/account/` | Header Sign in / Account, customer sign-in and account pages |
| `tests/security/admin/admin-api.test.mjs` (15), `tests/e2e/admin-pages.test.mjs` (14) | Stage 06 tests |
| `docs/architecture/admin.md`, decisions 029 to 031 | Design, roles, pages, audit, limits |

## Required tests

| ID | Requirement | Where | Result |
| --- | --- | --- | --- |
| CHV-S06-001 | /admin and admin APIs blocked for customers | `admin-api.test.mjs` "customers cannot reach admin APIs"; `admin-pages.test.mjs` "the shop host never serves the admin", "a signed-in customer gets a plain 404 on every admin page"; `admin-api.test.mjs` "with ADMIN_URL set, admin APIs answer only on the admin host" | Pass |
| CHV-S06-002 | Staff cannot edit roles, refund beyond permission or open owner settings | `admin-api.test.mjs` "staff limits" (4 tests); `admin-pages.test.mjs` "STAFF sees no Settings or Audit link" | Pass |
| CHV-S06-003 | Sensitive admin changes record canonical audit events | `admin-api.test.mjs` "canonical audit events" (5 tests, including refusal without a reason and rejection of incomplete events) | Pass |
| CHV-S06-004 | Empty states show no invented sales data | `admin-pages.test.mjs` overview and planned-section tests; static check for chart libraries and hard-coded amounts | Pass |

Refunds are tested at the permission level only (`canApproveRefund`); the refund flow arrives in Stage 15.

## Results

| File | Command | Result |
| --- | --- | --- |
| `unit-test.log` | `npm test` | 67 of 67 pass |
| `db-test.log` | `npm run test:db` | 46 of 46 pass |
| `security-test.log` | `npm run test:security` | 63 of 63 pass (includes the 15 admin API tests) |
| `e2e-pages.log` | `npm run test:e2e` against `next start` | 14 of 14 pass (rerun after the header change and robots.txt) |
| `lint.log` | `npm run lint` | Clean |
| `typecheck.log` | `npm run typecheck` | Clean |
| `build.log` | `npm run build` | Compiled successfully |
| `secret-scan.log` | `npm run scan:secrets -- --env-file .env.local .next evidence` | No secrets found (names only listed) |

Unit, database and security logs were captured before a final CSS-only header change; lint, typecheck, build, page tests and the secret scan were rerun after it.

## Browser check (16 October 2026)

On a production build with a throwaway database, `ADMIN_URL=http://admin.localhost:5660`:

- Storefront header shows Sign in; clicking it opens `/account/sign-in`. Checked at desktop width, 375px and 320px.
- Found and fixed: at 375px the new account icon overlapped the logo. The header icons now use tighter spacing on phones and the bag count sits on the icon; the logo and icons no longer overlap at 375px or 320px.
- Admin host: signed-out visitors land on the admin login page. Shop host `/admin`: the ordinary "Page not found" page.
- Signed-in admin pages (overview, settings, audit) were verified over HTTP by the page tests, not in the browser: putting a test session into the browser was blocked by the tool's credential safeguard.

## Open items for the owner

1. Confirm the admin address (`admin.chaanavya.in`; the request said "admin.chanavya.in") and add it as a Vercel domain with DNS.
2. Decide the ADMIN refund threshold (decision 030, proposed ₹10,000).
3. Before deploying: the shop would show placeholder products and cannot take orders. This conflicts with the 14 October decision that production never shows demonstration merchandise (decision 031).
4. Legal review of the reworded Privacy section 6 and Terms section 24.
5. Connect an email provider so customers receive sign-in codes outside development.
6. Reviewer for Stage 06: unassigned.
