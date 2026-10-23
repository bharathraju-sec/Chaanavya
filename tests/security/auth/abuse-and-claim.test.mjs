// Abuse controls (rate limits, enumeration-resistant responses) and the guest-order claim flow.
import { after, before, describe, test } from "node:test"
import assert from "node:assert/strict"
import { apiModule, authCall, call, createStaff, Jar, newIp, orderData, setup, signInCustomer } from "./helpers.mjs"

let ctx
before(async () => (ctx = await setup("chaanavya_test_s05_abuse")))
after(() => ctx?.teardown())

describe("rate limits", () => {
  test("a fourth sign-in code request within a minute from one address is refused", async () => {
    const ip = newIp()
    const statuses = []
    for (let i = 0; i < 4; i++) statuses.push((await authCall(ctx, "/email-otp/send-verification-otp", { body: { email: `burst${i}@example.com`, type: "sign-in" }, ip })).status)
    assert.deepEqual(statuses, [200, 200, 200, 429])
    assert.equal((await authCall(ctx, "/email-otp/send-verification-otp", { body: { email: "other@example.com", type: "sign-in" }, ip: newIp() })).status, 200, "another client is not affected")
  })

  test("password guessing is limited to five tries a minute", async () => {
    await createStaff(ctx, "guessing.target@example.com", "STAFF")
    const ip = newIp()
    const statuses = []
    for (let i = 0; i < 6; i++) statuses.push((await authCall(ctx, "/sign-in/email", { body: { email: "guessing.target@example.com", password: `wrong password ${i}!` }, ip })).status)
    assert.equal(statuses.at(-1), 429)
    assert.ok(statuses.slice(0, 5).every(s => s === 401))
  })

  test("limits are kept in the database, shared by every server instance", async () => {
    assert.ok((await ctx.db.rateLimit.count()) > 0)
  })
})

describe("enumeration resistance", () => {
  test("asking for a code looks the same for known and unknown addresses", async () => {
    await signInCustomer(ctx, "known.person@example.com")
    const known = await authCall(ctx, "/email-otp/send-verification-otp", { body: { email: "known.person@example.com", type: "sign-in" }, ip: newIp() })
    const unknown = await authCall(ctx, "/email-otp/send-verification-otp", { body: { email: "nobody.here@example.com", type: "sign-in" }, ip: newIp() })
    assert.equal(known.status, unknown.status)
    assert.deepEqual(known.json, unknown.json)
  })

  test("a wrong password and an unknown email get the same answer", async () => {
    await createStaff(ctx, "real.staff@example.com", "STAFF")
    const wrong = await authCall(ctx, "/sign-in/email", { body: { email: "real.staff@example.com", password: "definitely not it 123" }, ip: newIp() })
    const missing = await authCall(ctx, "/sign-in/email", { body: { email: "no.such.staff@example.com", password: "definitely not it 123" }, ip: newIp() })
    assert.equal(wrong.status, missing.status)
    assert.equal(wrong.json?.code, missing.json?.code)
  })

  test("public password sign-up is closed", async () => {
    const res = await authCall(ctx, "/sign-up/email", { body: { email: "self.made.admin@example.com", password: "a long enough password", name: "x" }, ip: newIp() })
    assert.notEqual(res.status, 200)
    assert.equal(await ctx.db.user.count({ where: { email: "self.made.admin@example.com" } }), 0)
  })
})

describe("claiming a guest order", () => {
  const claim = (jar, orderNumber) => call(ctx.routes.claim.POST, "/api/account/claim-order", { method: "POST", jar, body: { orderNumber } })

  test("the verified owner of the order's email can claim it, exactly once", async () => {
    const { session } = await ctx.guest.createGuestSession(ctx.db)
    const order = await ctx.db.order.create({ data: orderData({ guestSessionId: session.id, email: "claimer@example.com" }) })
    const jar = await signInCustomer(ctx, "claimer@example.com")
    const res = await claim(jar, order.number)
    assert.equal(res.status, 200)
    const user = await ctx.db.user.findUniqueOrThrow({ where: { email: "claimer@example.com" } })
    assert.equal((await ctx.db.order.findUniqueOrThrow({ where: { id: order.id } })).userId, user.id)
    assert.equal((await claim(jar, order.number)).status, 404, "already claimed")
    assert.equal(await ctx.db.auditEvent.count({ where: { action: "order.claimed", entityId: order.id } }), 1)
  })

  test("someone else's order, a missing order and a malformed number all look the same", async () => {
    const order = await ctx.db.order.create({ data: orderData({ email: "rightful@example.com" }) })
    const jar = await signInCustomer(ctx, "intruder@example.com")
    const responses = await Promise.all([claim(jar, order.number), claim(jar, "CHV-999999"), claim(jar, "1001"), claim(jar, null)])
    for (const res of responses) {
      assert.equal(res.status, 404)
      assert.deepEqual(res.json, { error: "not_found" })
    }
    assert.equal((await ctx.db.order.findUniqueOrThrow({ where: { id: order.id } })).userId, null)
  })

  test("an old sign-in must be renewed before claiming", async () => {
    const order = await ctx.db.order.create({ data: orderData({ email: "stale.claimer@example.com" }) })
    const jar = await signInCustomer(ctx, "stale.claimer@example.com")
    const user = await ctx.db.user.findUniqueOrThrow({ where: { email: "stale.claimer@example.com" } })
    await ctx.db.authSession.updateMany({ where: { userId: user.id }, data: { createdAt: new Date(Date.now() - 16 * 60_000) } })
    const res = await claim(jar, order.number)
    assert.equal(res.status, 403)
    assert.deepEqual(res.json, { error: "reauthentication_required" })
  })

  test("a guest without an account cannot claim", async () => {
    const { token } = await ctx.guest.createGuestSession(ctx.db)
    assert.equal((await claim(new Jar({ [ctx.guest.GUEST_COOKIE]: token }), "CHV-100001")).status, 401)
  })
})

describe("identity events are auditable", () => {
  test("sign-ins, sign-outs, role grants and denials are recorded, without codes or full emails", async () => {
    const jar = await signInCustomer(ctx, "audited.person@example.com")
    await authCall(ctx, "/sign-out", { jar, ip: newIp() })
    const events = await ctx.db.auditEvent.findMany()
    const actions = new Set(events.map(e => e.action))
    for (const action of ["identity.user_created", "identity.signed_in", "identity.signed_out", "staff.created"]) assert.ok(actions.has(action), action)
    const codes = ctx.otp.devOutbox.map(m => m.otp)
    for (const event of events) {
      const text = JSON.stringify(event)
      assert.ok(!text.includes("@example.com"), `email in ${event.action}`)
      assert.ok(!codes.some(code => text.includes(`"${code}"`)), `code in ${event.action}`)
    }
  })
})

describe("cookies over https", () => {
  test("an https site gets Secure, __Secure- prefixed session cookies", async () => {
    const { createAuth } = await apiModule("auth/server")
    const httpsAuth = createAuth({ db: ctx.db, secret: process.env.BETTER_AUTH_SECRET, baseURL: "https://shop.example", sendOtp: ctx.otp.deliverOtp, secureCookies: true })
    const post = (path, body) =>
      httpsAuth.handler(new Request(`https://shop.example/api/auth${path}`, { method: "POST", headers: { "content-type": "application/json", origin: "https://shop.example", "x-forwarded-for": newIp() }, body: JSON.stringify(body) }))
    await post("/email-otp/send-verification-otp", { email: "secure.cookie@example.com", type: "sign-in" })
    const res = await post("/sign-in/email-otp", { email: "secure.cookie@example.com", otp: ctx.otp.latestDevOtp("secure.cookie@example.com", "sign-in") })
    assert.equal(res.status, 200)
    const cookie = res.headers.getSetCookie().find(c => c.includes("session_token"))
    assert.match(cookie, /^__Secure-chaanavya\.session_token=/)
    assert.match(cookie, /; Secure/i)
    assert.match(cookie, /; HttpOnly/i)
    assert.match(cookie, /; SameSite=Lax/i)
  })
})
