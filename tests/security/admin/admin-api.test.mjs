// Stage 06 admin API: CHV-S06-001 (customers blocked), CHV-S06-002 (staff cannot edit roles,
// refund beyond permission or reach owner settings), CHV-S06-003 (sensitive admin mutations record
// canonical audit events), plus the shared API patterns (ETag/If-Match, validation, pagination)
// and the admin host split.
import { after, before, describe, test } from "node:test"
import assert from "node:assert/strict"
import { apiModule, call, setup, signInCustomer, staffWithMfa } from "../auth/helpers.mjs"

let ctx, customer, staff, admin, owner, owner2, target

before(async () => {
  ctx = await setup("chaanavya_test_s06_admin")
  customer = await signInCustomer(ctx, "s06.customer@example.com")
  staff = await staffWithMfa(ctx, "s06.staff@example.com", "STAFF")
  admin = await staffWithMfa(ctx, "s06.admin@example.com", "ADMIN")
  owner = await staffWithMfa(ctx, "s06.owner@example.com", "OWNER")
  owner2 = await staffWithMfa(ctx, "s06.owner2@example.com", "OWNER")
  target = await staffWithMfa(ctx, "s06.target@example.com", "STAFF")
})
after(() => ctx?.teardown())

const r = () => ctx.routes
const getStaff = (jar, userId) => call(r().staffOne.GET, `/api/admin/staff/${userId}`, { jar, params: { userId } })
const grant = (jar, userId, role, { etag, reason = "needs to approve refunds", headers = {}, extra = {} } = {}) =>
  call(r().roles.POST, `/api/admin/staff/${userId}/roles`, { method: "POST", jar, params: { userId }, body: { role, reason, ...extra }, headers: { ...(etag && { "if-match": etag }), ...headers } })
const revoke = (jar, userId, role, { etag, reason = "role no longer needed" } = {}) =>
  call(r().roleRevoke.DELETE, `/api/admin/staff/${userId}/roles/${role}`, { method: "DELETE", jar, params: { userId, role }, body: { reason }, headers: etag ? { "if-match": etag } : {} })
const deactivate = (jar, userId, { etag, reason = "left the company" } = {}) =>
  call(r().deactivate.POST, `/api/admin/staff/${userId}/deactivate`, { method: "POST", jar, params: { userId }, body: { reason }, headers: etag ? { "if-match": etag } : {} })
const etagOf = async userId => (await getStaff(owner.jar, userId)).json.data.etag

describe("CHV-S06-001 customers cannot reach admin APIs", () => {
  test("every Stage 06 admin API refuses a signed-in customer and a visitor", async () => {
    const calls = [
      jar => call(r().staffList.GET, "/api/admin/staff", { jar }),
      jar => getStaff(jar, target.user.id),
      jar => grant(jar, target.user.id, "ADMIN", { etag: 'W/"x"' }),
      jar => revoke(jar, target.user.id, "STAFF", { etag: 'W/"x"' }),
      jar => deactivate(jar, target.user.id, { etag: 'W/"x"' }),
      jar => call(r().settings.GET, "/api/admin/settings", { jar }),
      jar => call(r().audit.GET, "/api/admin/audit", { jar }),
    ]
    for (const run of calls) {
      assert.equal((await run(customer)).status, 403)
      assert.equal((await run(undefined)).status, 401)
    }
  })
})

describe("CHV-S06-002 staff limits", () => {
  test("STAFF and ADMIN cannot change roles or deactivate anyone", async () => {
    for (const actor of [staff, admin]) {
      assert.equal((await grant(actor.jar, target.user.id, "ADMIN", { etag: await etagOf(target.user.id) })).status, 403)
      assert.equal((await revoke(actor.jar, target.user.id, "STAFF", { etag: await etagOf(target.user.id) })).status, 403)
      assert.equal((await deactivate(actor.jar, target.user.id, { etag: await etagOf(target.user.id) })).status, 403)
      assert.equal((await call(r().staffList.GET, "/api/admin/staff", { jar: actor.jar })).status, 403)
    }
    assert.deepEqual((await getStaff(owner.jar, target.user.id)).json.data.roles, ["STAFF"], "nothing changed")
  })

  test("STAFF and ADMIN cannot open owner settings", async () => {
    assert.equal((await call(r().settings.GET, "/api/admin/settings", { jar: staff.jar })).status, 403)
    assert.equal((await call(r().settings.GET, "/api/admin/settings", { jar: admin.jar })).status, 403)
    const ok = await call(r().settings.GET, "/api/admin/settings", { jar: owner.jar })
    assert.equal(ok.status, 200)
    const text = JSON.stringify(ok.json)
    assert.ok(!text.includes(process.env.BETTER_AUTH_SECRET), "settings never return values")
    assert.ok(ok.json.data.settings.some(s => s.name === "BETTER_AUTH_SECRET" && s.status === "set"))
  })

  test("refund approval limits: STAFF none, ADMIN up to the threshold, OWNER any amount", async () => {
    const { canApproveRefund, REFUND_LARGE_THRESHOLD_PAISE } = await apiModule("auth/policies")
    const { capabilitiesFor } = await import("@chaanavya/shared/auth/rbac")
    const caps = role => capabilitiesFor([role])
    assert.equal(canApproveRefund(caps("STAFF"), 100), false)
    assert.equal(canApproveRefund(caps("ADMIN"), REFUND_LARGE_THRESHOLD_PAISE), true)
    assert.equal(canApproveRefund(caps("ADMIN"), REFUND_LARGE_THRESHOLD_PAISE + 1), false)
    assert.equal(canApproveRefund(caps("OWNER"), REFUND_LARGE_THRESHOLD_PAISE * 100), true)
    for (const bad of [0, -5, 1.5, Number.NaN]) assert.equal(canApproveRefund(caps("OWNER"), bad), false)
  })

  test("an owner cannot change their own access, and the last active owner is protected", async () => {
    const self = await revoke(owner.jar, owner.user.id, "OWNER", { etag: await etagOf(owner.user.id) })
    assert.equal(self.status, 409)
    const solo = await ctx.staff.revokeRole(ctx.db, { userId: owner2.user.id, role: "OWNER", actor: { kind: "system", process: "test" }, reason: "setup for last-owner check", correlationId: "t" })
    assert.equal(solo, "revoked")
    const last = await deactivate(owner2.jar, owner.user.id, { etag: await etagOf(owner.user.id) })
    assert.ok([401, 409].includes(last.status), "owner2 lost the role (401) or would be blocked")
    await assert.rejects(
      ctx.staff.deactivateUser(ctx.db, { userId: owner.user.id, actor: { kind: "system", process: "test" }, reason: "last owner check", correlationId: "t" }),
      /last active owner/,
    )
    await ctx.staff.grantRole(ctx.db, { userId: owner2.user.id, role: "OWNER", actor: { kind: "system", process: "test" }, reason: "restore second owner", correlationId: "t" })
    owner2.jar = (await staffWithMfaReuse(owner2)).jar
  })
})

// owner2's sessions were revoked with the role; sign in again with the same authenticator.
async function staffWithMfaReuse(member) {
  const { signInStaff } = await import("../auth/helpers.mjs")
  return { jar: await signInStaff(ctx, member.user.email, member.password, member.secret) }
}

describe("CHV-S06-003 canonical audit events", () => {
  test("granting a role records actor, entity, time, reason and correlation ID from the session", async () => {
    const etag = await etagOf(target.user.id)
    const res = await grant(owner.jar, target.user.id, "ADMIN", { etag, reason: "covers refunds this month", headers: { "x-correlation-id": "corr-s06-grant-0001" }, extra: { actorId: admin.user.id, actor: { kind: "staff", id: admin.user.id } } })
    assert.equal(res.status, 200)
    assert.deepEqual(res.json.data.staff.roles, ["ADMIN", "STAFF"])
    const event = await ctx.db.auditEvent.findFirstOrThrow({ where: { action: "staff.role_granted", entityId: target.user.id } })
    assert.equal(event.actorKind, "staff")
    assert.equal(event.actorId, owner.user.id, "actor comes from the session, not the request body")
    assert.equal(event.entityType, "user")
    assert.equal(event.reason, "covers refunds this month")
    assert.equal(event.correlationId, "corr-s06-grant-0001")
    assert.deepEqual(event.after, { role: "ADMIN" })
    assert.ok(event.occurredAt instanceof Date)
  })

  test("revoking a role signs the person out and is audited with the role and session count", async () => {
    const etag = await etagOf(target.user.id)
    const res = await revoke(owner.jar, target.user.id, "ADMIN", { etag, reason: "month ended" })
    assert.equal(res.status, 200)
    const event = await ctx.db.auditEvent.findFirstOrThrow({ where: { action: "staff.role_revoked", entityId: target.user.id } })
    assert.deepEqual(event.before, { role: "ADMIN" })
    assert.equal(typeof event.after.sessionsRevoked, "number")
    assert.equal((await call(r().me.GET, "/api/admin/me", { jar: target.jar })).status, 401)
  })

  test("deactivation and sign-out-everywhere are audited", async () => {
    const victim = await staffWithMfa(ctx, "s06.leaver@example.com", "STAFF")
    const signOut = await call(r().sessions.DELETE, `/api/admin/staff/${victim.user.id}/sessions`, { method: "DELETE", jar: owner.jar, body: { reason: "phone lost" }, params: { userId: victim.user.id } })
    assert.equal(signOut.status, 200)
    const res = await deactivate(owner.jar, victim.user.id, { etag: await etagOf(victim.user.id), reason: "left the company" })
    assert.equal(res.status, 200)
    assert.ok(res.json.data.staff.disabledAt)
    for (const action of ["staff.sessions_revoked", "staff.deactivated"]) {
      const event = await ctx.db.auditEvent.findFirstOrThrow({ where: { action, entityId: victim.user.id } })
      assert.equal(event.actorId, owner.user.id)
    }
  })

  test("a change without a reason is refused and leaves no trace", async () => {
    const before = await ctx.db.auditEvent.count()
    const res = await grant(owner.jar, target.user.id, "ADMIN", { etag: await etagOf(target.user.id), reason: " " })
    assert.equal(res.status, 400)
    assert.equal(res.json.error.fields.reason, "required")
    assert.equal(await ctx.db.auditEvent.count(), before)
  })

  test("the audit catalogue rejects incomplete events", async () => {
    const { validateAdminEvent } = await apiModule("audit/catalogue")
    const base = { actor: { kind: "staff", id: "u" }, entity: { type: "product_variant", id: "v" }, reason: "promo price", correlationId: "c" }
    assert.throws(() => validateAdminEvent({ ...base, action: "price.changed", after: { pricePaise: 1 } }), /before.pricePaise/)
    assert.throws(() => validateAdminEvent({ ...base, action: "price.changed", reason: "", before: { pricePaise: 2 }, after: { pricePaise: 1 } }), /reason/)
    assert.throws(() => validateAdminEvent({ ...base, action: "refund.approved", after: { amountPaise: 1 } }), /must reference a refund/)
    assert.throws(() => validateAdminEvent({ ...base, action: "inventory.adjusted", after: { delta: -1 } }), /reasonCode/)
    assert.doesNotThrow(() => validateAdminEvent({ ...base, action: "inventory.adjusted", after: { delta: -1, reasonCode: "damaged" } }))
  })
})

describe("API patterns", () => {
  test("mutations need the current ETag: missing is 428, stale is 412", async () => {
    const missing = await grant(owner.jar, target.user.id, "ADMIN")
    assert.equal(missing.status, 428)
    assert.equal(missing.json.error.code, "precondition_required")
    const stale = await etagOf(target.user.id)
    await ctx.staff.grantRole(ctx.db, { userId: target.user.id, role: "OWNER", actor: { kind: "system", process: "test" }, reason: "concurrent change", correlationId: "t" })
    const conflict = await grant(owner.jar, target.user.id, "ADMIN", { etag: stale })
    assert.equal(conflict.status, 412)
    assert.equal(conflict.json.error.code, "precondition_failed")
    assert.ok(!(await getStaff(owner.jar, target.user.id)).json.data.roles.includes("ADMIN"))
    await ctx.staff.revokeRole(ctx.db, { userId: target.user.id, role: "OWNER", actor: { kind: "system", process: "test" }, reason: "undo", correlationId: "t" })
  })

  test("bad input gets a structured 400", async () => {
    const etag = await etagOf(target.user.id)
    const res = await grant(owner.jar, target.user.id, "SUPERUSER", { etag })
    assert.equal(res.status, 400)
    assert.deepEqual(Object.keys(res.json.error).sort(), ["code", "fields", "message"])
    assert.equal((await call(r().audit.GET, "/api/admin/audit?limit=0", { jar: owner.jar })).status, 400)
    assert.equal((await call(r().audit.GET, "/api/admin/audit?cursor=***", { jar: owner.jar })).status, 400)
    assert.equal((await call(r().audit.GET, "/api/admin/audit?actorId=not-a-uuid", { jar: owner.jar })).status, 400)
    assert.equal((await getStaff(owner.jar, "not-a-uuid")).status, 404)
  })

  test("the audit list pages with a cursor and filters", async () => {
    const first = await call(r().audit.GET, "/api/admin/audit?limit=2", { jar: owner.jar })
    assert.equal(first.status, 200)
    assert.equal(first.json.data.length, 2)
    assert.ok(first.json.page.nextCursor)
    const second = await call(r().audit.GET, `/api/admin/audit?limit=2&cursor=${first.json.page.nextCursor}`, { jar: owner.jar })
    const ids = new Set([...first.json.data, ...second.json.data].map(e => e.id))
    assert.equal(ids.size, 4, "no overlap between pages")
    const filtered = await call(r().audit.GET, `/api/admin/audit?action=staff.deactivated`, { jar: owner.jar })
    assert.ok(filtered.json.data.length >= 1 && filtered.json.data.every(e => e.action === "staff.deactivated"))
  })
})

describe("admin on its own host", () => {
  test("with ADMIN_URL set, admin APIs answer only on the admin host", async () => {
    process.env.ADMIN_URL = "https://admin.shop.example"
    try {
      const onShop = await call(r().me.GET, "/api/admin/me", { jar: owner.jar, headers: { host: "shop.example" } })
      assert.equal(onShop.status, 404)
      const onAdmin = await call(r().me.GET, "/api/admin/me", { jar: owner.jar, headers: { host: "admin.shop.example" } })
      assert.equal(onAdmin.status, 200)
    } finally {
      delete process.env.ADMIN_URL
    }
  })

  test("host helpers", async () => {
    const { adminAllowedHere, adminBasePath, isAdminHost } = await import("@chaanavya/shared/admin/host")
    const env = { ADMIN_URL: "https://admin.chaanavya.in" }
    const h = host => new Headers({ host })
    assert.equal(isAdminHost(h("admin.chaanavya.in"), env), true)
    assert.equal(isAdminHost(h("chaanavya.in"), env), false)
    assert.equal(adminAllowedHere(h("chaanavya.in"), env), false)
    assert.equal(adminAllowedHere(h("anything.local"), {}), true, "without ADMIN_URL the admin lives at /admin")
    assert.equal(adminBasePath(h("admin.chaanavya.in"), env), "")
    assert.equal(adminBasePath(h("localhost:3000"), {}), "/admin")
    assert.equal(isAdminHost(new Headers({ host: "evil.example", "x-forwarded-host": "admin.chaanavya.in" }), env), true, "Vercel's forwarded host wins")
  })
})
