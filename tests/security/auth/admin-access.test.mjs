// CHV-S05-002: a customer cannot reach admin APIs through direct requests. Also: every admin and
// account route has an access rule (static check of the API's route metadata), roles limit
// capabilities, denials are audited, cross-site writes are refused, and the web host holds no API logic.
import { after, before, describe, test } from "node:test"
import assert from "node:assert/strict"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { apiModule, call, setup, signInCustomer, staffWithMfa } from "./helpers.mjs"

const API = fileURLToPath(new URL("../../../app/api/", import.meta.url))
let ctx, customer, staff, admin, owner

before(async () => {
  ctx = await setup("chaanavya_test_s05_admin")
  customer = await signInCustomer(ctx, "plain.customer@example.com")
  staff = await staffWithMfa(ctx, "packer@example.com", "STAFF")
  admin = await staffWithMfa(ctx, "manager@example.com", "ADMIN")
  owner = await staffWithMfa(ctx, "founder@example.com", "OWNER")
})
after(() => ctx?.teardown())

const adminCalls = () => [
  ["GET /api/admin/me", jar => call(ctx.routes.me.GET, "/api/admin/me", { jar })],
  ["GET /api/admin/audit", jar => call(ctx.routes.audit.GET, "/api/admin/audit", { jar })],
  ["DELETE /api/admin/staff/:id/sessions", jar => call(ctx.routes.sessions.DELETE, `/api/admin/staff/${staff.user.id}/sessions`, { method: "DELETE", jar, body: { reason: "test" }, params: { userId: staff.user.id } })],
]

describe("CHV-S05-002 customers cannot reach admin APIs", () => {
  test("no session: 401 on every admin route", async () => {
    for (const [name, run] of adminCalls()) assert.equal((await run(undefined)).status, 401, name)
  })

  test("a signed-in customer: 403 on every admin route, and nothing changes", async () => {
    const before = await ctx.db.authSession.count({ where: { userId: staff.user.id } })
    for (const [name, run] of adminCalls()) {
      const res = await run(customer)
      assert.equal(res.status, 403, name)
      assert.deepEqual(res.json, { error: "forbidden" }, name)
    }
    assert.equal(await ctx.db.authSession.count({ where: { userId: staff.user.id } }), before, "the staff member's sessions were not revoked")
  })

  test("denials are audited without personal data", async () => {
    const denied = await ctx.db.auditEvent.findMany({ where: { action: "identity.access_denied", reason: { startsWith: "forbidden" } } })
    assert.ok(denied.length >= 3)
    assert.ok(denied.every(e => !JSON.stringify(e).includes("plain.customer@example.com")))
  })

  test("a forged cookie or a bearer-style header does not help", async () => {
    const res = await call(ctx.routes.me.GET, "/api/admin/me", { headers: { cookie: "chaanavya.session_token=forged.value", authorization: "Bearer forged" } })
    assert.equal(res.status, 401)
  })
})

describe("roles limit capabilities", () => {
  test("STAFF can read their profile but cannot read the audit log or manage staff", async () => {
    assert.equal((await call(ctx.routes.me.GET, "/api/admin/me", { jar: staff.jar })).status, 200)
    assert.equal((await call(ctx.routes.audit.GET, "/api/admin/audit", { jar: staff.jar })).status, 403)
    assert.equal((await call(ctx.routes.sessions.DELETE, `/api/admin/staff/${admin.user.id}/sessions`, { method: "DELETE", jar: staff.jar, body: { reason: "test" }, params: { userId: admin.user.id } })).status, 403)
  })

  test("ADMIN reads the audit log but cannot manage staff; OWNER can", async () => {
    assert.equal((await call(ctx.routes.audit.GET, "/api/admin/audit", { jar: admin.jar })).status, 200)
    assert.equal((await call(ctx.routes.sessions.DELETE, `/api/admin/staff/${staff.user.id}/sessions`, { method: "DELETE", jar: admin.jar, body: { reason: "test" }, params: { userId: staff.user.id } })).status, 403)
    const revoked = await call(ctx.routes.sessions.DELETE, `/api/admin/staff/${staff.user.id}/sessions`, { method: "DELETE", jar: owner.jar, body: { reason: "lost phone" }, params: { userId: staff.user.id } })
    assert.equal(revoked.status, 200)
    assert.ok(revoked.json.data.revoked >= 1)
    assert.equal((await call(ctx.routes.me.GET, "/api/admin/me", { jar: staff.jar })).status, 401, "revoked sessions stop working at once")
  })

  test("staff with orders.read can read any order; a customer only their own", async () => {
    const order = await ctx.db.order.create({ data: { email: "someone@example.com", subtotalPaise: BigInt(100), grandTotalPaise: BigInt(100), shippingAddress: {}, submitKey: "admin-access-order" } })
    assert.equal((await call(ctx.routes.order.GET, `/api/orders/${order.id}`, { jar: admin.jar, params: { id: order.id } })).status, 200)
    assert.equal((await call(ctx.routes.order.GET, `/api/orders/${order.id}`, { jar: customer, params: { id: order.id } })).status, 404)
  })
})

describe("request protections", () => {
  test("cross-site writes are refused before any permission check", async () => {
    const res = await call(ctx.routes.sessions.DELETE, `/api/admin/staff/${admin.user.id}/sessions`, { method: "DELETE", jar: owner.jar, origin: "https://evil.example", body: { reason: "x" }, params: { userId: admin.user.id } })
    assert.equal(res.status, 403)
    assert.deepEqual(res.json, { error: "cross_site" })
    const fetchMeta = await call(ctx.routes.claim.POST, "/api/account/claim-order", { method: "POST", jar: customer, headers: { "sec-fetch-site": "cross-site" }, body: { orderNumber: "CHV-100001" } })
    assert.equal(fetchMeta.status, 403)
  })

  test("Better Auth refuses sign-in requests from another origin", async () => {
    const res = await call(ctx.routes.authRoute.POST, "/api/auth/sign-in/email", { method: "POST", origin: "https://evil.example", headers: { cookie: "chaanavya.session_token=x" }, body: { email: "founder@example.com", password: owner.password } })
    assert.equal(res.status, 403)
  })
})

describe("static check: privileged routes are always guarded", () => {
  // Routes and their access rules, read from the built NestJS controllers (route metadata).
  const apiRoutes = async () => {
    const { ACCESS_RULE } = await apiModule("http/access")
    const { METHOD_METADATA, PATH_METADATA } = await import("@nestjs/common/constants.js")
    const routes = []
    for (const area of ["admin", "account", "orders", "session", "health"]) {
      for (const Controller of Object.values(await apiModule(`modules/${area}.controller`))) {
        const base = Reflect.getMetadata(PATH_METADATA, Controller) ?? ""
        for (const name of Object.getOwnPropertyNames(Controller.prototype)) {
          const handler = Controller.prototype[name]
          if (name === "constructor" || Reflect.getMetadata(METHOD_METADATA, handler) === undefined) continue
          routes.push({ area, route: `${base}/${Reflect.getMetadata(PATH_METADATA, handler) ?? ""}`, rule: Reflect.getMetadata(ACCESS_RULE, handler) ?? Reflect.getMetadata(ACCESS_RULE, Controller) })
        }
      }
    }
    return routes
  }

  test("every API route declares an access rule (the guard refuses routes without one)", async () => {
    const routes = await apiRoutes()
    assert.ok(routes.length >= 15, `found ${routes.length} routes`)
    for (const r of routes) assert.ok(r.rule, `${r.route} has no access rule`)
  })

  test("every admin route requires a staff capability; account routes a signed-in customer", async () => {
    const routes = await apiRoutes()
    const admin = routes.filter(r => r.area === "admin")
    assert.ok(admin.length >= 9)
    for (const r of admin) assert.equal(r.rule.kind, "permission", r.route)
    for (const r of routes.filter(r => r.area === "account")) assert.equal(r.rule.kind, "customer", r.route)
  })

  test("the order route decides ownership itself; only the health probes skip every check", async () => {
    const routes = await apiRoutes()
    for (const r of routes.filter(r => r.area === "orders")) assert.equal(r.rule.kind, "shopper", r.route)
    assert.deepEqual(routes.filter(r => r.rule.kind === "probe").map(r => r.area), ["health", "health"])
  })

  test("the web host holds no API logic: only the forwarder, the chat route and the cache refresh route, no database or sign-in imports", () => {
    const files = dir => readdirSync(dir).flatMap(e => (statSync(join(dir, e)).isDirectory() ? files(join(dir, e)) : [join(dir, e)]))
    const routeFiles = files(API).filter(f => f.endsWith("route.ts")).map(f => f.slice(API.length).replaceAll("\\", "/"))
    // internal/revalidate (Stage 10.10) only expires cached catalogue reads, for the worker, behind the internal key.
    assert.deepEqual(routeFiles.sort(), ["[...path]/route.ts", "chat/route.ts", "internal/revalidate/route.ts"])
    const refresh = readFileSync(join(API, "internal/revalidate/route.ts"), "utf8")
    assert.match(refresh, /INTERNAL_KEY_HEADER/, "the refresh route checks the internal key")
    assert.doesNotMatch(refresh, /@prisma|better-auth|apps\/api|\bdb\b|DATABASE_URL/, "and holds no data or sign-in logic")
    const web = fileURLToPath(new URL("../../../", import.meta.url))
    for (const dir of ["app", "components", "lib", "proxy.ts"].map(d => join(web, d))) {
      for (const file of statSync(dir).isDirectory() ? files(dir) : [dir]) {
        if (!/\.(ts|tsx)$/.test(file)) continue
        // Code only: comments may name the API files they mirror.
        const code = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
        assert.doesNotMatch(code, /@prisma\/|better-auth|apps\/api|lib\/db\/|DATABASE_URL/, file)
      }
    }
  })
})
