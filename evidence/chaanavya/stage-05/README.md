# Stage 05 evidence: identity, customer accounts, guest sessions and RBAC

Captured 15 to 16 October 2026 in the upgrade workspace `backup/upgrade` (copy of main 7347829; main is 60ea71a, untouched). Every new route answers 404 unless `COMMERCE_BACKEND=chaanavya`, so the live Shopify store is unaffected (verified against `next start`, run 1 in `http-smoke.log`).

## Deliverables

| Path | Contents |
| --- | --- |
| `lib/auth/server.ts` | Better Auth 1.7.7: customer email codes, staff password + TOTP, database sessions recording how they were created, database-backed rate limits, origin check forced on, audit hooks |
| `lib/auth/guards.ts` | `withCustomer`, `withPermission`, `commerceRoute`, same-origin check, ownership helpers |
| `lib/auth/rbac.ts` | OWNER, ADMIN, STAFF and 16 capabilities |
| `lib/auth/guest.ts` | Guest sessions: random cookie token, SHA-256 hash stored |
| `lib/auth/claim.ts` | Explicit guest-order claim (verified email match, recent sign-in, uniform 404) |
| `lib/auth/staff.ts` | Staff creation (Better Auth password hashing), role revoke and user disable (sessions end at once) |
| `lib/auth/audit.ts`, `lib/auth/otp-delivery.ts` | Identity audit events; code delivery (development console only until Stage 18) |
| `app/api/auth/[...all]`, `app/api/account/{orders,claim-order}`, `app/api/orders/[id]`, `app/api/admin/{me,audit,staff/[userId]/sessions}` | Routes, all guarded and flag-gated |
| `prisma/migrations/20261015120000_auth_and_guest_sessions`, `20261015130000_verification_text_id` + rollbacks | Better Auth tables; `session` renamed to `guest_session` in place (hand-reviewed: Prisma's SQL would have dropped data and a CHECK constraint) |
| `lib/config/env.ts` | `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` rules; `isCommerceBackendEnabled` |
| `tests/security/auth/` (49 tests), `tests/support/` | Security tests calling the real route handlers with real requests; `@/` import loader for Node |
| `docs/architecture/identity.md`, decisions 025 to 028, `docs/operations/secrets.md` | Design, flows, recovery, roles, known limits |

## Results

| File | Result |
| --- | --- |
| security-test.log | `npm run test:security`: 49/49, exit 0 |
| unit-test.log | `npm test`: 68/68 (adds sign-in setting checks) |
| db-test.log | `npm run test:db`: 46/46 (3 migrations, 32 tables, rollbacks newest first) |
| lint.log, typecheck.log, build.log | all exit 0; build lists the 7 new API routes |
| http-smoke.log | `next start`: run 1 flag off, every new route 404, shop pages 200; run 2 flag on, real sign-in by emailed code, cookie `HttpOnly; SameSite=Lax`, customer 403 on admin, 401 without session, cross-site writes 403 (ours and Better Auth's), sign-out ends the session |
| secret-scan.log | No secrets in `.next` or `evidence/`; one false positive (jose's PEM header check) fixed in the scanner with positive controls |

## Test case status

| Case | Status | Where |
| --- | --- | --- |
| CHV-S05-001 guest cannot read another guest's cart or order | Pass | `guest-isolation.test.mjs` (other guest, forged, hashed, expired, revoked, customer cross-checks; carts via the ownership rule, cart API arrives in Stage 11) |
| CHV-S05-002 customer cannot reach admin APIs via direct requests | Pass | `admin-access.test.mjs` (401/403 on every admin route, denials audited, role limits, static check that every admin/account handler is guarded) |
| CHV-S05-003 admin without MFA cannot perform privileged actions | Pass | `mfa.test.mjs` (no enrolment, TOTP challenge, email-code session even with TOTP, disable 2FA, role revoke, disable user, backup codes) |
| CHV-S05-004 expired recovery/OTP tokens are refused | Pass | `tokens.test.mjs` (expired sign-in and reset codes, single use, 3 attempts, hashed storage, expired session, sign-out) |

Definition of done: auth and RBAC integration tests pass; privileged routes all enforce permissions (static check); guest and registered sessions isolated; sensitive identity events auditable (tested, no emails or codes in audit rows).

## Found and fixed during the stage

1. Better Auth's two-factor challenge only covers password sign-in, so an email-code session would have skipped MFA. Sessions now record their method and admin access requires `password_2fa`.
2. Better Auth disables its origin (CSRF) check in test environments; forced on so tests match production.
3. Our cross-site check let requests through when no Host header was present; it now falls back to the request URL (fails closed).
4. `verification.id` must be text: Better Auth derives some keys from the identifier (migration 3).
5. The two-factor audit fired on every TOTP re-verification; it now records actual enable/disable changes.
6. Session cookies were not `Secure` on https staging; now `Secure` and `__Secure-` prefixed whenever the site URL is https (tested).

## Hand-off: unresolved for Stage 06

1. Decision 012 (Shopify independence) is still proposed; no reviewer named for Stages 01 to 05.
2. No email provider (Stage 18): sign-in codes are only printed in development; staging and production cannot send codes yet.
3. No pages: admin login and shell are Stage 06, account pages Stage 15. The APIs exist and are tested.
4. Owner bootstrap (first OWNER account) is Stage 06; `lib/auth/staff.ts` provides the building block.
5. Better Auth 1.7.8 and 1.7.9 to be reviewed after 28 October 2026.
6. No per-email limit on code requests (per-IP limits and 3 attempts per code exist).
7. Copying back to main also brings `postinstall: prisma generate`, `engines >=22.18` and the new Better Auth dependency into the Vercel build; check the Vercel Node version first.
