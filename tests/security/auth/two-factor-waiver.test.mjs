// TEMPORARY development switch ADMIN_TWO_FACTOR=off (packages/shared/src/auth/two-factor-waiver.ts):
// staff may use the admin with a password alone while the admin is being built. These tests keep it
// honest: off unless set, in effect only in development, refused by the configuration check anywhere
// else, and never sticky. The real rule (every staff sign-in passes two-factor) is tested by the
// other auth tests, which run without the switch.
import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import { checkEnv } from "../../../packages/shared/src/config/env.ts"
import { twoFactorWaived } from "../../../packages/shared/src/auth/two-factor-waiver.ts"
import { authCall, call, createStaff, Jar, newIp, setup } from "./helpers.mjs"

test("the switch is off unless it is set to off in development", () => {
  assert.equal(twoFactorWaived({}), false, "unset")
  assert.equal(twoFactorWaived({ ADMIN_TWO_FACTOR: "off" }), true, "development is the default environment")
  assert.equal(twoFactorWaived({ APP_ENV: "development", ADMIN_TWO_FACTOR: "off" }), true)
  for (const value of ["on", "", " ", "OFF", "false", "0", "no", "disabled"]) assert.equal(twoFactorWaived({ APP_ENV: "development", ADMIN_TWO_FACTOR: value }), false, `"${value}"`)
})

test("the switch is ignored outside development, however the environment is named", () => {
  for (const env of [{ APP_ENV: "staging" }, { APP_ENV: "production" }, { VERCEL_ENV: "production" }, { VERCEL_ENV: "preview" }]) {
    assert.equal(twoFactorWaived({ ...env, ADMIN_TWO_FACTOR: "off" }), false, JSON.stringify(env))
  }
})

test("the configuration check refuses off outside development and anything but on or off", () => {
  const problems = (env, target) => checkEnv(env, { target, service: "api" }).errors.filter(e => e.name === "ADMIN_TWO_FACTOR")
  assert.deepEqual(problems({ ADMIN_TWO_FACTOR: "off" }, "development"), [])
  assert.deepEqual(problems({ ADMIN_TWO_FACTOR: "on" }, "production"), [])
  assert.deepEqual(problems({}, "production"), [], "unset is the safe default")
  for (const target of ["staging", "production"]) {
    const [problem] = problems({ ADMIN_TWO_FACTOR: "off" }, target)
    assert.match(problem?.problem ?? "", /outside development/, target)
  }
  assert.match(problems({ ADMIN_TWO_FACTOR: "maybe" }, "development")[0]?.problem ?? "", /on or off/)
})

// ---- the API: a staff account that never set up two-factor -------------------------------------------

let ctx, staff
const saved = process.env.ADMIN_TWO_FACTOR
before(async () => {
  delete process.env.ADMIN_TWO_FACTOR
  ctx = await setup("chaanavya_test_two_factor_waiver")
  staff = await createStaff(ctx, "waiver.owner@example.com", "OWNER")
})
after(async () => {
  if (saved === undefined) delete process.env.ADMIN_TWO_FACTOR
  else process.env.ADMIN_TWO_FACTOR = saved
  await ctx?.teardown()
})

async function passwordSignIn() {
  const jar = new Jar()
  const res = await authCall(ctx, "/sign-in/email", { body: { email: "waiver.owner@example.com", password: staff.password }, jar, ip: newIp() })
  assert.equal(res.status, 200)
  assert.ok(!res.json.twoFactorRedirect, "this account has no authenticator")
  return jar
}
const me = jar => call(ctx.routes.me.GET, "/api/admin/me", { jar })
const session = jar => call(ctx.routes.me.GET, "/api/session", { jar })

test("by default a password sign-in alone is refused: two-factor is required", async () => {
  const jar = await passwordSignIn()
  const res = await me(jar)
  assert.deepEqual([res.status, res.json.error], [403, "mfa_required"])
  const s = (await session(jar)).json.user
  assert.deepEqual([s.twoFactorEnabled, s.passedTwoFactor, s.twoFactorWaived], [false, false, false])
})

test("with the switch off in development a password sign-in reaches the admin, and the session says so", async () => {
  process.env.ADMIN_TWO_FACTOR = "off"
  try {
    const jar = await passwordSignIn()
    const res = await me(jar)
    assert.equal(res.status, 200)
    assert.ok(res.json.capabilities.includes("catalogue.publish"), "an owner keeps exactly an owner's permissions")
    const s = (await session(jar)).json.user
    assert.deepEqual([s.twoFactorEnabled, s.passedTwoFactor, s.twoFactorWaived], [false, false, true], "nothing is claimed that did not happen")
    // Permissions are still checked: a signed-out caller and a customer get nothing.
    assert.equal((await me(new Jar())).status, 401)
  } finally {
    delete process.env.ADMIN_TWO_FACTOR
  }
})

test("the switch is not sticky: turning it off again refuses the same session", async () => {
  process.env.ADMIN_TWO_FACTOR = "off"
  const jar = await passwordSignIn()
  assert.equal((await me(jar)).status, 200)
  delete process.env.ADMIN_TWO_FACTOR
  assert.equal((await me(jar)).status, 403, "the very next request needs two-factor again")
})

test("outside development the switch does nothing even if it is set", async () => {
  const jar = await passwordSignIn()
  process.env.ADMIN_TWO_FACTOR = "off"
  const env = process.env.APP_ENV
  process.env.APP_ENV = "staging"
  try {
    const res = await me(jar)
    assert.deepEqual([res.status, res.json.error], [403, "mfa_required"])
  } finally {
    process.env.APP_ENV = env
    delete process.env.ADMIN_TWO_FACTOR
  }
})
