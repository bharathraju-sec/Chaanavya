// CHV-S05-004: expired recovery and one-time codes are refused. Also: codes are single-use,
// limited to three attempts, stored hashed, and expired sessions stop working.
import { after, before, describe, test } from "node:test"
import assert from "node:assert/strict"
import { authCall, call, createStaff, Jar, newIp, setup, signInCustomer } from "./helpers.mjs"

let ctx
before(async () => (ctx = await setup("chaanavya_test_s05_tokens")))
after(() => ctx?.teardown())

const sendCode = (email, type = "sign-in", ip = newIp()) => authCall(ctx, "/email-otp/send-verification-otp", { body: { email, type }, ip })
const expireCodes = () => ctx.db.verification.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } })

describe("CHV-S05-004 expired codes and sessions are refused", () => {
  test("an expired sign-in code is refused", async () => {
    const email = "expired.code@example.com"
    await sendCode(email)
    const otp = ctx.otp.latestDevOtp(email, "sign-in")
    await expireCodes()
    const jar = new Jar()
    const res = await authCall(ctx, "/sign-in/email-otp", { body: { email, otp }, jar, ip: newIp() })
    assert.notEqual(res.status, 200)
    assert.ok(!jar.has("session_token"))
  })

  test("codes expire after five minutes by configuration", async () => {
    const email = "ttl.code@example.com"
    const sentAt = Date.now()
    await sendCode(email)
    const row = await ctx.db.verification.findFirstOrThrow({ where: { identifier: { contains: email } }, orderBy: { createdAt: "desc" } })
    const ttl = row.expiresAt.getTime() - sentAt
    assert.ok(ttl > 4 * 60_000 && ttl <= 5 * 60_000 + 5_000, `ttl ${ttl} ms`)
  })

  test("an expired password-reset code is refused and the password is unchanged", async () => {
    const { password } = await createStaff(ctx, "reset.expired@example.com", "STAFF")
    await sendCode("reset.expired@example.com", "forget-password")
    const otp = ctx.otp.latestDevOtp("reset.expired@example.com", "forget-password")
    await expireCodes()
    const reset = await authCall(ctx, "/email-otp/reset-password", { body: { email: "reset.expired@example.com", otp, password: "a brand new passphrase 1" }, ip: newIp() })
    assert.notEqual(reset.status, 200)
    const signIn = await authCall(ctx, "/sign-in/email", { body: { email: "reset.expired@example.com", password }, jar: new Jar(), ip: newIp() })
    assert.equal(signIn.status, 200, "old password still works")
  })

  test("a valid reset code works once and signs the user out everywhere", async () => {
    const email = "reset.valid@example.com"
    const { password } = await createStaff(ctx, email, "STAFF")
    const jar = new Jar()
    await authCall(ctx, "/sign-in/email", { body: { email, password }, jar, ip: newIp() })
    assert.equal((await call(ctx.routes.accountOrders.GET, "/api/account/orders", { jar })).status, 200)
    await sendCode(email, "forget-password")
    const otp = ctx.otp.latestDevOtp(email, "forget-password")
    const reset = await authCall(ctx, "/email-otp/reset-password", { body: { email, otp, password: "a brand new passphrase 2" }, ip: newIp() })
    assert.equal(reset.status, 200)
    assert.equal((await call(ctx.routes.accountOrders.GET, "/api/account/orders", { jar })).status, 401, "existing sessions revoked")
    const again = await authCall(ctx, "/email-otp/reset-password", { body: { email, otp, password: "yet another passphrase 3" }, ip: newIp() })
    assert.notEqual(again.status, 200, "the reset code cannot be reused")
  })

  test("a sign-in code works once", async () => {
    const email = "single.use@example.com"
    await sendCode(email)
    const otp = ctx.otp.latestDevOtp(email, "sign-in")
    assert.equal((await authCall(ctx, "/sign-in/email-otp", { body: { email, otp }, jar: new Jar(), ip: newIp() })).status, 200)
    assert.notEqual((await authCall(ctx, "/sign-in/email-otp", { body: { email, otp }, jar: new Jar(), ip: newIp() })).status, 200)
  })

  test("three wrong attempts burn the code, even for the right value afterwards", async () => {
    const email = "attempts@example.com"
    await sendCode(email)
    const otp = ctx.otp.latestDevOtp(email, "sign-in")
    const wrong = otp === "000000" ? "111111" : "000000"
    for (let i = 0; i < 3; i++) assert.notEqual((await authCall(ctx, "/sign-in/email-otp", { body: { email, otp: wrong }, ip: newIp() })).status, 200)
    const late = await authCall(ctx, "/sign-in/email-otp", { body: { email, otp }, jar: new Jar(), ip: newIp() })
    assert.notEqual(late.status, 200)
  })

  test("codes are stored hashed, never as the six digits", async () => {
    const email = "hashed.code@example.com"
    await sendCode(email)
    const otp = ctx.otp.latestDevOtp(email, "sign-in")
    const rows = await ctx.db.verification.findMany({ where: { identifier: { contains: email } } })
    assert.ok(rows.length > 0)
    for (const row of rows) assert.ok(!row.value.includes(otp))
  })

  test("an expired session is refused", async () => {
    const jar = await signInCustomer(ctx, "expiring.session@example.com")
    assert.equal((await call(ctx.routes.accountOrders.GET, "/api/account/orders", { jar })).status, 200)
    const user = await ctx.db.user.findUniqueOrThrow({ where: { email: "expiring.session@example.com" } })
    await ctx.db.authSession.updateMany({ where: { userId: user.id }, data: { expiresAt: new Date(Date.now() - 1000) } })
    assert.equal((await call(ctx.routes.accountOrders.GET, "/api/account/orders", { jar })).status, 401)
  })

  test("signing out ends the session", async () => {
    const jar = await signInCustomer(ctx, "signing.out@example.com")
    const copy = new Jar(Object.fromEntries(jar.cookies))
    assert.equal((await authCall(ctx, "/sign-out", { jar, ip: newIp() })).status, 200)
    assert.equal((await call(ctx.routes.accountOrders.GET, "/api/account/orders", { jar: copy })).status, 401, "a copied cookie stops working too")
  })
})
