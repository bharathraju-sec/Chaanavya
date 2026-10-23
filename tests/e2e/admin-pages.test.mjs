// Stage 06 pages over real HTTP against the production build (`npm run build` first).
// CHV-S06-001: admin pages are invisible to customers and visitors (404 / login redirect).
// CHV-S06-004: admin empty states show no invented sales data.
// Also: the admin answers only on its own host, and the storefront header's sign-in button opens
// our sign-in page. Starts its own API (`apps/api/dist`, Stage 07) and `next start` with a throwaway
// database; the pages reach the API only through the web host's forwarder. .env.local is untouched.
import { after, before, describe, test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { request as httpRequest } from "node:http"
import { join } from "node:path"
import { dropDatabase, freshDatabase, ROOT } from "../integration/database/helpers.mjs"
import { apiModule, secretFromUri, totp } from "../security/auth/helpers.mjs"

const PORT = 5650
const API_PORT = 5651
const SHOP = `localhost:${PORT}`
const ADMIN = `admin.localhost:${PORT}`
const DB = "chaanavya_test_s06_pages"
let server
let api
let output = ""

/** Minimal HTTP client that can set the Host header (fetch cannot). */
function http(method, host, path, { cookies = new Map(), body, origin } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { host, ...(cookies.size && { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; ") }), ...(body && { "content-type": "application/json", origin: origin ?? `http://${host}` }) }
    const req = httpRequest({ host: "127.0.0.1", port: PORT, method, path, headers }, res => {
      let text = ""
      res.setEncoding("utf8")
      res.on("data", chunk => (text += chunk))
      res.on("end", () => {
        for (const line of res.headers["set-cookie"] ?? []) {
          const [pair, ...attrs] = line.split(";")
          const [name, ...rest] = pair.trim().split("=")
          if (rest.join("=") === "" || attrs.some(a => /max-age=0/i.test(a))) cookies.delete(name)
          else cookies.set(name, rest.join("="))
        }
        let json = null
        try {
          json = JSON.parse(text)
        } catch {
          /* page HTML */
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json, cookies })
      })
    })
    req.on("error", reject)
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}

const latestCode = email => {
  const matches = [...output.matchAll(/code for (\S+): (\d{6})/g)].filter(m => m[1].startsWith(email[0]) && m[1].endsWith(email.split("@")[1]))
  return matches.at(-1)?.[2]
}

before(async () => {
  assert.ok(existsSync(join(ROOT, ".next", "BUILD_ID")), "run `npm run build` before the page tests")
  assert.ok(existsSync(join(ROOT, "apps", "api", "dist", "main.js")), "run `npm run build:api` before the page tests")
  const { url, client } = freshDatabase(DB)
  await client.$disconnect()
  const key = randomBytes(32).toString("base64url")
  Object.assign(process.env, { DATABASE_URL: url, BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"), BETTER_AUTH_URL: `http://${SHOP}`, ADMIN_URL: `http://${ADMIN}`, APP_ENV: "development", API_INTERNAL_KEY: key })
  // The API holds the database and auth secrets; the web host gets only the API's address and key.
  api = spawn(process.execPath, [join(ROOT, "apps", "api", "dist", "main.js")], { cwd: join(ROOT, "apps", "api"), env: { ...process.env, API_PORT: String(API_PORT) } })
  const webEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !["DATABASE_URL", "BETTER_AUTH_SECRET"].includes(name)))
  server = spawn(process.execPath, [join(ROOT, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)], { cwd: ROOT, env: { ...webEnv, API_URL: `http://127.0.0.1:${API_PORT}`, NODE_ENV: "production" } })
  for (const child of [api, server]) {
    child.stdout.on("data", d => (output += d))
    child.stderr.on("data", d => (output += d))
  }
  for (let i = 0; i < 60; i++) {
    try {
      if ((await http("GET", SHOP, "/")).status === 200 && (await http("GET", SHOP, "/api/session")).status === 200) return
    } catch {
      /* not up yet */
    }
    await new Promise(r => setTimeout(r, 1000))
  }
  throw new Error(`the API or next start did not come up:\n${output.slice(-2000)}`)
})

after(() => {
  server?.kill()
  api?.kill()
  dropDatabase(DB)
})

async function customer(email) {
  const cookies = new Map()
  await http("POST", SHOP, "/api/auth/email-otp/send-verification-otp", { cookies, body: { email, type: "sign-in" } })
  await new Promise(r => setTimeout(r, 300))
  const res = await http("POST", SHOP, "/api/auth/sign-in/email-otp", { cookies, body: { email, otp: latestCode(email) } })
  assert.equal(res.status, 200, `customer sign-in failed: ${res.text}`)
  return cookies
}

async function staff(email, role) {
  const [{ auth }, { db }, { createStaffUser }] = await Promise.all([apiModule("auth/server"), apiModule("db/client"), apiModule("auth/staff")])
  const password = "correct horse battery staple"
  await createStaffUser(auth(), db(), { email, password, role, actor: { kind: "system", process: "test" }, reason: "page test fixture", correlationId: "e2e" })
  const cookies = new Map()
  const first = await http("POST", ADMIN, "/api/auth/sign-in/email", { cookies, body: { email, password } })
  assert.equal(first.status, 200, first.text)
  const setup = await http("GET", ADMIN, "/", { cookies })
  assert.equal(setup.status, 307, "no authenticator yet: sent to enrolment")
  assert.equal(setup.headers.location, "/setup-mfa")
  assert.equal((await http("GET", ADMIN, "/setup-mfa", { cookies })).status, 200)
  const enabled = await http("POST", ADMIN, "/api/auth/two-factor/enable", { cookies, body: { password } })
  assert.equal(enabled.status, 200, enabled.text)
  const verified = await http("POST", ADMIN, "/api/auth/two-factor/verify-totp", { cookies, body: { code: totp(secretFromUri(enabled.json.totpURI)) } })
  assert.equal(verified.status, 200, verified.text)
  return cookies
}

describe("CHV-S06-001 admin pages are blocked for customers and visitors", () => {
  test("the shop host never serves the admin", async () => {
    for (const path of ["/admin", "/admin/login", "/admin/settings"]) {
      const res = await http("GET", SHOP, path)
      assert.equal(res.status, 404, path)
      assert.match(res.text, /Page not found/)
    }
    assert.equal((await http("GET", SHOP, "/api/admin/me")).status, 404)
  })

  test("signed-out visitors on the admin host are sent to the login page, which is not indexed", async () => {
    const res = await http("GET", ADMIN, "/")
    assert.equal(res.status, 307)
    assert.equal(res.headers.location, "/login")
    const login = await http("GET", ADMIN, "/login")
    assert.equal(login.status, 200)
    assert.match(login.text, /Sign in/)
    assert.match(login.headers["x-robots-tag"], /noindex/)
    assert.match(login.text, /<meta name="robots" content="noindex, nofollow/)
  })

  test("old /admin/... addresses on the admin host redirect to the short form", async () => {
    const res = await http("GET", ADMIN, "/admin/orders")
    assert.equal(res.status, 308)
    assert.equal(res.headers.location, "/orders")
  })

  test("a signed-in customer gets a plain 404 on every admin page", async () => {
    const cookies = await customer("page.customer@example.com")
    for (const path of ["/", "/orders", "/settings", "/audit", "/setup-mfa"]) {
      const res = await http("GET", ADMIN, path, { cookies })
      assert.equal(res.status, 404, path)
      assert.doesNotMatch(res.text, /Overview|Audit trail|Team/, path)
    }
  })

  test("unknown admin addresses are a plain 404", async () => {
    assert.equal((await http("GET", ADMIN, "/jewellery")).status, 404)
  })
})

describe("roles and empty states", () => {
  let owner, packer

  before(async () => {
    owner = await staff("page.owner@example.com", "OWNER")
    packer = await staff("page.packer@example.com", "STAFF")
  })

  test("CHV-S06-004 the overview shows no sales figures, sample rows or currency amounts", async () => {
    const res = await http("GET", ADMIN, "/", { cookies: owner })
    assert.equal(res.status, 200)
    assert.match(res.text, /No sales figures yet/)
    assert.doesNotMatch(res.text, /₹|Rs\.?\s?\d|\d+(\.\d+)?%/)
  })

  test("CHV-S06-004 every planned section says it is not built yet and shows no data", async () => {
    for (const path of ["/orders", "/customers", "/shipments", "/payments", "/returns", "/promotions"]) {
      const res = await http("GET", ADMIN, path, { cookies: owner })
      assert.equal(res.status, 200, path)
      assert.match(res.text, /Not built yet/, path)
      assert.doesNotMatch(res.text, /<table|₹/, path)
    }
  })

  test("the owner sees team and configuration; values never appear", async () => {
    const res = await http("GET", ADMIN, "/settings", { cookies: owner })
    assert.equal(res.status, 200)
    assert.match(res.text, /page\.packer@example\.com/)
    assert.match(res.text, /BETTER_AUTH_SECRET/)
    assert.ok(!res.text.includes(process.env.BETTER_AUTH_SECRET))
  })

  test("STAFF sees no Settings or Audit link, and those pages refuse them", async () => {
    const overview = await http("GET", ADMIN, "/", { cookies: packer })
    assert.equal(overview.status, 200)
    assert.doesNotMatch(overview.text, /href="\/settings"|href="\/audit"/)
    for (const path of ["/settings", "/audit"]) {
      const res = await http("GET", ADMIN, path, { cookies: packer })
      assert.match(res.text, /is not part of your role/, path)
      assert.doesNotMatch(res.text, /page\.owner@example\.com|BETTER_AUTH_SECRET/, path)
    }
  })

  test("CHV-S08 products: an empty catalogue says so; STAFF can look but gets no editing controls", async () => {
    const empty = await http("GET", ADMIN, "/products", { cookies: owner })
    assert.equal(empty.status, 200)
    assert.match(empty.text, /No products yet/)
    assert.match(empty.text, /href="\/products\/new"/)
    assert.doesNotMatch(empty.text, /₹/, "no invented prices")
    const staffView = await http("GET", ADMIN, "/products", { cookies: packer })
    assert.equal(staffView.status, 200)
    assert.doesNotMatch(staffView.text, /href="\/products\/new"|href="\/products\/import"/)
    for (const path of ["/products/new", "/products/import"]) assert.match((await http("GET", ADMIN, path, { cookies: packer })).text, /is not part of your role/, path)
  })

  test("CHV-S08 product editor, preview, collections and import pages render from the API", async () => {
    const dresses = (await http("GET", ADMIN, "/api/admin/catalogue/collections", { cookies: owner })).json.data.find(c => c.handle === "dresses")
    const created = await http("POST", ADMIN, "/api/admin/catalogue/products", { cookies: owner, body: { title: "Page test linen dress", collectionIds: [dresses.id] } })
    assert.equal(created.status, 201, created.text)
    const id = created.json.data.id
    const editor = await http("GET", ADMIN, `/products/${id}`, { cookies: owner })
    assert.equal(editor.status, 200)
    for (const text of ["Page test linen dress", "Variants and prices", "Photos", "Before this product can go live", "Write the product description", "Choose the shipping restriction"]) assert.match(editor.text, new RegExp(text), text)
    const preview = await http("GET", ADMIN, `/products/${id}/preview`, { cookies: owner })
    assert.equal(preview.status, 200)
    assert.match(preview.text, /Preview of a draft product/)
    assert.match(preview.text, /Shoppers cannot see this page/)
    const collections = await http("GET", ADMIN, "/products/collections", { cookies: owner })
    for (const handle of ["/dresses", "/ethnic-festive", "/jewellery", "/fragrance"]) assert.ok(collections.text.includes(handle), handle)
    assert.match((await http("GET", ADMIN, "/products/import", { cookies: owner })).text, /stock is never imported/)
    const list = await http("GET", ADMIN, "/products?status=draft", { cookies: owner })
    assert.match(list.text, /Page test linen dress/)
    // Workspace pages stream (loading.tsx), so a missing product shows the not-found page with status
    // 200; non-staff are refused earlier, in the layout, with a real 404. The admin host is never indexed.
    const missing = await http("GET", ADMIN, "/products/00000000-0000-4000-8000-000000000000", { cookies: owner })
    assert.match(missing.text, /Nothing here\./)
    assert.doesNotMatch(missing.text, /Variants and prices/)
    assert.equal((await http("GET", SHOP, `/api/catalogue/products/${created.json.data.handle}`)).status, 404, "the draft is not public")
  })

  test("CHV-S08/S09 a signed-in customer gets a 404 on the product and inventory pages", async () => {
    const cookies = await customer("page.customer2@example.com")
    for (const path of ["/products", "/products/new", "/products/collections", "/inventory", "/inventory/stocktakes"]) assert.equal((await http("GET", ADMIN, path, { cookies })).status, 404, path)
  })

  test("admin pages may load photos and send uploads to the photo store; shop pages may not upload", async () => {
    const admin = await http("GET", ADMIN, "/products", { cookies: owner })
    const csp = admin.headers["content-security-policy"]
    assert.match(csp, /connect-src 'self' http:\/\/127\.0\.0\.1:9090/)
    assert.match(csp, /img-src [^;]*http:\/\/127\.0\.0\.1:9090/)
    const shop = (await http("GET", SHOP, "/")).headers["content-security-policy"]
    assert.match(shop, /connect-src 'self'(;| https)/)
  })

  test("CHV-S09 inventory: stock list, stocktakes; STAFF reads but cannot start a count", async () => {
    const list = await http("GET", ADMIN, "/inventory", { cookies: owner })
    assert.equal(list.status, 200)
    assert.match(list.text, /A SKU goes on sale only after an approved stocktake/)
    assert.doesNotMatch(list.text, /₹/, "no invented values")
    const stocktakes = await http("GET", ADMIN, "/inventory/stocktakes", { cookies: owner })
    assert.match(stocktakes.text, /Start a stocktake/)
    assert.match(stocktakes.text, /No stocktakes yet/)
    const started = await http("POST", ADMIN, "/api/admin/inventory/stocktakes", { cookies: owner, body: { note: "Page test count" } })
    assert.equal(started.status, 201, started.text)
    const page = await http("GET", ADMIN, `/inventory/stocktakes/${started.json.data.id}`, { cookies: owner })
    assert.match(page.text, /Page test count/)
    assert.match(page.text, /Finish counting/)
    const packerView = await http("GET", ADMIN, "/inventory/stocktakes", { cookies: packer })
    assert.equal(packerView.status, 200)
    assert.doesNotMatch(packerView.text, /Start a stocktake/)
  })

  test("the audit trail page lists real entries", async () => {
    const res = await http("GET", ADMIN, "/audit", { cookies: owner })
    assert.equal(res.status, 200)
    assert.match(res.text, /staff\.created/)
  })
})

describe("storefront header", () => {
  test("the sign-in button opens our sign-in page; signed in, it says Account", async () => {
    const visitor = await http("GET", SHOP, "/")
    assert.match(visitor.text, /href="\/account\/sign-in"[^>]*aria-label="Sign in or create an account"|aria-label="Sign in or create an account"[^>]*href="\/account\/sign-in"/)
    assert.equal((await http("GET", SHOP, "/account/sign-in")).status, 200)
    const cookies = await customer("header.customer@example.com")
    const signedIn = await http("GET", SHOP, "/jewellery", { cookies })
    assert.match(signedIn.text, /aria-label="Your account"/)
    const account = await http("GET", SHOP, "/account", { cookies })
    assert.equal(account.status, 200)
    assert.match(account.text, /No orders yet/)
    assert.equal((await http("GET", SHOP, "/account/sign-in", { cookies })).status, 307)
  })

  test("robots.txt: the shop keeps crawlers out of private paths; the admin host blocks everything", async () => {
    const shop = await http("GET", SHOP, "/robots.txt")
    assert.equal(shop.status, 200)
    assert.match(shop.text, /Disallow: \/api\//)
    assert.match(shop.text, /Disallow: \/account/)
    assert.match(shop.text, /Sitemap: https:\/\/chaanavya\.in\/sitemap\.xml/)
    const sitemap = await http("GET", SHOP, "/sitemap.xml")
    assert.equal(sitemap.status, 200)
    // Stage 10.11: the sitemap follows the database. With nothing published it lists the home page and
    // the information pages only: no product, and no empty collection page (those are not indexed).
    assert.match(sitemap.text, /chaanavya\.in\/terms/)
    assert.doesNotMatch(sitemap.text, /chaanavya\.in\/jewellery/, "an empty collection is not listed")
    assert.doesNotMatch(sitemap.text, /\/products\//, "placeholder products stay out of the sitemap")
    const admin = await http("GET", ADMIN, "/robots.txt")
    assert.equal(admin.status, 200)
    assert.equal(admin.text, "User-agent: *\nDisallow: /\n")
    assert.equal((await http("GET", ADMIN, "/sitemap.xml")).status, 404)
  })

  test("no Shopify anywhere in storefront pages", async () => {
    for (const path of ["/", "/products/merlot-wrap-dress", "/track-order", "/privacy-policy", "/terms"]) {
      assert.doesNotMatch((await http("GET", SHOP, path)).text, /shopify/i, path)
    }
  })
})

describe("static check", () => {
  test("admin code has no chart libraries or hard-coded money figures", () => {
    const files = dir => readdirSync(dir).flatMap(e => (statSync(join(dir, e)).isDirectory() ? files(join(dir, e)) : [join(dir, e)]))
    for (const file of [...files(join(ROOT, "app", "admin")), ...files(join(ROOT, "components", "admin"))]) {
      const text = readFileSync(file, "utf8")
      assert.doesNotMatch(text, /recharts|chart\.js|nivo|victory/i, file)
      assert.doesNotMatch(text, /₹\s?\d|Rs\.?\s?\d/, file)
    }
  })
})
