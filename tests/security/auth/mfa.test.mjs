// CHV-S05-003: an admin without MFA cannot perform privileged actions. Privileged access needs a
// staff role, an enrolled authenticator, and a session created by password + TOTP sign-in.
import { after, before, describe, test } from "node:test"
import assert from "node:assert/strict"
import { authCall, call, createStaff, Jar, newIp, setup, signInCustomer, signInStaff, staffWithMfa, totp } from "./helpers.mjs"

let ctx
before(async () => (ctx = await setup("chaanavya_test_s05_mfa")))
after(() => ctx?.teardown())

const adminMe = jar => call(ctx.routes.me.GET, "/api/admin/me", { jar })

describe("CHV-S05-003 privileged actions require MFA", () => {
  test("an ADMIN who has not enrolled two-factor is refused with mfa_required", async () => {
    const { password } = await createStaff(ctx, "no.mfa.admin@example.com", "ADMIN")
    const jar = new Jar()
    const signIn = await authCall(ctx, "/sign-in/email", { body: { email: "no.mfa.admin@example.com", password }, jar, ip: newIp() })
    assert.equal(signIn.status, 200, "password sign-in itself works")
    const res = await adminMe(jar)
    assert.equal(res.status, 403)
    assert.deepEqual(res.json, { error: "mfa_required" })
    assert.equal((await call(ctx.routes.audit.GET, "/api/admin/audit", { jar })).status, 403)
  })

  test("with two-factor enrolled, password sign-in stops at the TOTP challenge and creates no session", async () => {
    const { password, secret } = await staffWithMfa(ctx, "challenge.admin@example.com", "ADMIN")
    const jar = new Jar()
    const ip = newIp()
    const first = await authCall(ctx, "/sign-in/email", { body: { email: "challenge.admin@example.com", password }, jar, ip })
    assert.equal(first.json.twoFactorRedirect, true)
    assert.ok(!jar.has("session_token"), "no session cookie before the second factor")
    assert.equal((await adminMe(jar)).status, 401)
    const wrong = await authCall(ctx, "/two-factor/verify-totp", { body: { code: totp(secret) === "000000" ? "111111" : "000000" }, jar, ip })
    assert.notEqual(wrong.status, 200)
    assert.equal((await adminMe(jar)).status, 401)
    const right = await authCall(ctx, "/two-factor/verify-totp", { body: { code: totp(secret) }, jar, ip })
    assert.equal(right.status, 200)
    assert.equal((await adminMe(jar)).status, 200)
  })

  test("a staff member signing in with an email code is only a customer, even after entering a TOTP code", async () => {
    const { secret } = await staffWithMfa(ctx, "otp.owner@example.com", "OWNER")
    const ip = newIp()
    const jar = await signInCustomer(ctx, "otp.owner@example.com", { ip })
    assert.deepEqual((await adminMe(jar)).json, { error: "mfa_required" })
    await authCall(ctx, "/two-factor/verify-totp", { body: { code: totp(secret) }, jar, ip })
    assert.equal((await adminMe(jar)).status, 403)
    assert.equal((await call(ctx.routes.accountOrders.GET, "/api/account/orders", { jar })).status, 200, "customer pages still work")
  })

  test("sessions record how they were created", async () => {
    const methods = new Set((await ctx.db.authSession.findMany({ select: { authMethod: true } })).map(s => s.authMethod))
    for (const method of ["password", "password_2fa", "email_otp"]) assert.ok(methods.has(method), method)
  })

  test("disabling two-factor removes admin access", async () => {
    const { password, jar } = await staffWithMfa(ctx, "disabling.admin@example.com", "ADMIN")
    assert.equal((await adminMe(jar)).status, 200)
    const disabled = await authCall(ctx, "/two-factor/disable", { body: { password }, jar, ip: newIp() })
    assert.equal(disabled.status, 200)
    assert.equal((await adminMe(jar)).status, 403)
    const audit = await ctx.db.auditEvent.findMany({ where: { action: { in: ["identity.two_factor_enabled", "identity.two_factor_disabled"] } }, orderBy: { occurredAt: "asc" } })
    assert.ok(audit.some(e => e.action === "identity.two_factor_disabled"))
  })

  test("losing the role or being disabled ends access immediately", async () => {
    const one = await staffWithMfa(ctx, "leaver.one@example.com", "ADMIN")
    await ctx.staff.revokeRole(ctx.db, { userId: one.user.id, role: "ADMIN", actor: { kind: "system", process: "test" }, reason: "test revoke", correlationId: "test-revoke" })
    assert.equal((await adminMe(one.jar)).status, 401, "sessions were revoked with the role")

    const two = await staffWithMfa(ctx, "leaver.two@example.com", "ADMIN")
    await ctx.staff.deactivateUser(ctx.db, { userId: two.user.id, actor: { kind: "system", process: "test" }, reason: "test deactivate", correlationId: "test-disable" })
    assert.equal((await adminMe(two.jar)).status, 401)
    await assert.rejects(signInStaff(ctx, "leaver.two@example.com", two.password, two.secret), /two-factor sign-in failed|expected a two-factor challenge/)
  })

  test("backup codes work once each", async () => {
    const { password, backupCodes } = await staffWithMfa(ctx, "backup.admin@example.com", "ADMIN")
    assert.equal(backupCodes.length, 10)
    const use = async () => {
      const jar = new Jar()
      const ip = newIp()
      await authCall(ctx, "/sign-in/email", { body: { email: "backup.admin@example.com", password }, jar, ip })
      return { res: await authCall(ctx, "/two-factor/verify-backup-code", { body: { code: backupCodes[0] }, jar, ip }), jar }
    }
    const first = await use()
    assert.equal(first.res.status, 200)
    assert.equal((await adminMe(first.jar)).status, 200)
    assert.notEqual((await use()).res.status, 200, "the same backup code is refused the second time")
  })
})
