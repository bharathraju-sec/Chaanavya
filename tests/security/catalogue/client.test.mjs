// CHV-S10-M06 (Stage 10.06): the storefront reads the public catalogue only through the NestJS API
// (lib/catalogue/client.ts); the web host never queries PostgreSQL for it. Timeouts, error answers
// and bad bodies become a safe "unavailable" result instead of an exception. Fixtures only.
import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { createServer } from "node:http"
import { join, relative } from "node:path"
import { setup, staffWithMfa } from "../auth/helpers.mjs"
import { catalogueApi, countStock, fullChecklist, mediaStoreReady, png, readyDraft, sizes, uploadPhoto } from "./helpers.mjs"
import { CATALOGUE_TAG, CATALOGUE_TIMEOUT_MS, revalidateSeconds, getCollectionPage, getProductPage, listCollections, listProducts } from "../../../lib/catalogue/client.ts"

const ROOT = new URL("../../../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")
const KEY = "stub-internal-key-for-tests"

// ---- the web host holds no database access ------------------------------------------------------

function sources(dir) {
  const found = []
  for (const name of readdirSync(dir)) {
    if (["node_modules", ".next", "dist", "generated"].includes(name)) continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) found.push(...sources(path))
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) found.push(path)
  }
  return found
}
const webHost = ["app", "components", "lib"].flatMap(d => sources(join(ROOT, d)))

test("CHV-S10-M06 no web host source imports a database driver, Prisma or API code", () => {
  const forbidden = [/from\s+["'](?:@prisma\/[^"']*|prisma|pg|pg-[^"']*|postgres|postgres\/[^"']*|mysql2?|better-sqlite3|drizzle-orm[^"']*|kysely|typeorm|sequelize|knex)["']/, /from\s+["'](?:@chaanavya\/api[^"']*|[./@][^"']*apps\/api\/[^"']*)["']/, /require\(["'](?:pg|@prisma\/client)["']\)/]
  const offenders = webHost.flatMap(file => {
    const text = readFileSync(file, "utf8")
    return forbidden.filter(re => re.test(text)).map(() => relative(ROOT, file))
  })
  assert.deepEqual(offenders, [])
  assert.ok(webHost.length > 50, "the scan covered the web host")
})

test("CHV-S10-M06 the catalogue client and storefront pages never read database settings", () => {
  const storefront = webHost.filter(f => /[\\/]lib[\\/]catalogue[\\/]/.test(f) || /[\\/]app[\\/]\(store\)[\\/]/.test(f) || /[\\/]components[\\/](product|site|cart)[\\/]/.test(f))
  assert.ok(storefront.length > 10)
  for (const file of storefront) assert.doesNotMatch(readFileSync(file, "utf8"), /DATABASE_URL|DIRECT_URL|POSTGRES_URL/, relative(ROOT, file))
  const client = readFileSync(join(ROOT, "lib/catalogue/client.ts"), "utf8")
  assert.doesNotMatch(client, /from\s+["']@\/lib\/catalog["']|fallbackProducts/, "no fallback to the demonstration catalogue")
  assert.match(client, /apiTarget/, "calls go to the configured API")
})

// ---- failure handling against a stub API --------------------------------------------------------

let stub, base, mode, seen
const target = () => ({ url: base, key: KEY })

before(async () => {
  stub = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers })
    if (mode === "hang") return // never answers
    if (mode === "boom") return req.socket.destroy()
    if (mode === "redirect") return void res.writeHead(302, { location: "http://evil.example/" }).end()
    if (mode === "garbage") return void res.writeHead(200, { "content-type": "application/json" }).end("<html>not json")
    if (mode === "500") return void res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: "internal_error" }))
    if (mode === "404") return void res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: "not_found", message: "not found" } }))
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [], page: { nextCursor: null } }))
  })
  await new Promise(resolve => stub.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${stub.address().port}`
})
after(() => new Promise(resolve => (stub ? stub.close(resolve) : resolve())))
const reset = m => {
  mode = m
  seen = []
}

test("CHV-S10-M06 a read is a plain GET to the API with the internal key and nothing about the visitor", async () => {
  reset("ok")
  const result = await listProducts({ limit: 7, collection: "ethnic-festive" }, { target: target() })
  assert.deepEqual(result, { status: "ok", data: { products: [], nextCursor: null } })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].method, "GET")
  assert.equal(seen[0].url, "/api/v1/catalogue/products?collection=ethnic-festive&limit=7")
  assert.equal(seen[0].headers["x-chaanavya-internal-key"], KEY)
  for (const h of ["cookie", "authorization", "x-forwarded-for", "x-real-ip", "user-agent-visitor"]) assert.equal(seen[0].headers[h], undefined, h)
  assert.equal(CATALOGUE_TAG, "catalogue")
})

test("CHV-S10-M06 a missing or hidden answer is not_found; other failures are unavailable, never an exception", async () => {
  reset("404")
  assert.deepEqual(await getProductPage("anything", null, { target: target() }), { status: "not_found" })
  assert.deepEqual(await getCollectionPage("anything", {}, { target: target() }), { status: "not_found" })
  for (const m of ["500", "garbage", "redirect", "boom"]) {
    reset(m)
    for (const call of [() => listProducts({}, { target: target() }), () => getProductPage("kurta", null, { target: target() }), () => getCollectionPage("ethnic-festive", {}, { target: target() }), () => listCollections({ target: target() })]) {
      assert.deepEqual(await call(), { status: "unavailable" }, m)
    }
  }
})

test("CHV-S10-M06 a slow API is cut off at the timeout, and an unreachable one is unavailable", async () => {
  reset("hang")
  const started = Date.now()
  assert.deepEqual(await listProducts({}, { target: target(), timeoutMs: 250 }), { status: "unavailable" })
  const took = Date.now() - started
  assert.ok(took >= 200 && took < 3000, `returned after ${took} ms`)
  assert.ok(CATALOGUE_TIMEOUT_MS <= 10_000, "the default timeout is short")
  assert.deepEqual(await listProducts({}, { target: { url: "http://127.0.0.1:1", key: KEY }, timeoutMs: 1000 }), { status: "unavailable" })
})

test("CHV-S10-M06 without an API address outside development the client is unavailable, not a crash", async () => {
  const saved = { ...process.env }
  Object.assign(process.env, { APP_ENV: "production" })
  delete process.env.API_URL
  delete process.env.API_INTERNAL_KEY
  try {
    assert.deepEqual(await listCollections(), { status: "unavailable" })
  } finally {
    process.env = saved
  }
})

test("CHV-S10-M06 malformed handles, variants and page options are refused before any request", async () => {
  reset("ok")
  const t = { target: target() }
  assert.equal((await getProductPage("../admin", null, t)).status, "not_found")
  assert.equal((await getProductPage("UPPER CASE", null, t)).status, "not_found")
  assert.equal((await getProductPage("kurta", "1 OR 1=1", t)).status, "not_found")
  assert.equal((await getCollectionPage("a/b", {}, t)).status, "not_found")
  assert.equal((await listProducts({ limit: 0 }, t)).status, "not_found")
  assert.equal((await listProducts({ limit: 49 }, t)).status, "not_found")
  assert.equal((await listProducts({ cursor: "{bad}" }, t)).status, "not_found")
  assert.equal((await listProducts({ collection: "x y" }, t)).status, "not_found")
  assert.equal(seen.length, 0)
})

test("CHV-S10-M06 the data cache time is 60 seconds unless a valid override is set", () => {
  assert.equal(revalidateSeconds({}), 60)
  assert.equal(revalidateSeconds({ CATALOGUE_REVALIDATE_SECONDS: "0" }), 0)
  assert.equal(revalidateSeconds({ CATALOGUE_REVALIDATE_SECONDS: "300" }), 300)
  for (const bad of ["", " ", "-1", "3601", "1.5", "soon"]) assert.equal(revalidateSeconds({ CATALOGUE_REVALIDATE_SECONDS: bad }), 60, bad)
})

// ---- the real API, from a process with no database settings --------------------------------------

test("CHV-S10-M06 against the real API, a process with no database settings reads published data and nothing hidden", async t => {
  await mediaStoreReady()
  const ctx = await setup("chaanavya_test_s10_client")
  t.after(() => ctx.teardown())
  const c = catalogueApi(ctx)
  const admin = await staffWithMfa(ctx, "s10m06.admin@example.com", "ADMIN")
  const owner = await staffWithMfa(ctx, "s10m06.owner@example.com", "OWNER")
  const ethnic = (await ctx.db.collection.findUnique({ where: { handle: "ethnic-festive" } })).id
  const p = `M06${process.pid}`

  const created = (await c.create(admin.jar, readyDraft([ethnic], { title: "Client kurta" }))).json.data
  const saved = (await c.variants(admin.jar, created.id, created.etag, sizes(`${p}A`))).json.data
  const photo = await uploadPhoto(c, admin.jar, created.id, png(600, 800))
  const approved = (await c.approve(owner.jar, photo.completed.json.data.media.at(-1).id, photo.completed.json.data.etag)).json.data
  const live = (await c.status(owner.jar, created.id, "publish", approved.etag, { reason: "client fixture", checklist: fullChecklist })).json.data
  await countStock(c, admin.jar, owner.jar, saved.variants.map((v, i) => ({ sku: v.sku, counted: i === 0 ? 3 : 0 })))
  const draft = (await c.create(admin.jar, readyDraft([ethnic], { title: "Client draft saree" }))).json.data

  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, APP_ENV: "development", NODE_ENV: "test", LOG_LEVEL: "error", API_URL: ctx.api.url, API_INTERNAL_KEY: ctx.api.key }
  // Async on purpose: the API runs inside this process, so a blocking spawn would freeze it.
  const run = await new Promise(resolve =>
    execFile(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--import", "./scripts/support/register.mjs", "tests/security/catalogue/client-child.mjs", live.handle, draft.handle], { cwd: ROOT, env, encoding: "utf8", timeout: 60_000 }, (error, stdout, stderr) => resolve({ status: error ? 1 : 0, stdout, stderr })),
  )
  assert.equal(run.status, 0, run.stderr)
  const out = JSON.parse(run.stdout.split("\n").find(l => l.startsWith("RESULT ")).slice(7))

  assert.equal(out.databaseConfigured, false, "the child process has no database settings")
  assert.deepEqual(out.list.data.products.map(x => x.id), [live.id])
  assert.equal(out.live.status, "ok")
  assert.equal(out.live.data.product.id, live.id)
  const first = out.live.data.product.variants.find(v => v.availableForSale)
  assert.equal(out.live.data.selection.selectedVariantId, first.id)
  assert.deepEqual(out.draft, { status: "not_found" })
  assert.deepEqual(out.collection.data.products.map(x => x.id), [live.id])
  assert.deepEqual(out.hiddenCollection, { status: "not_found" })
  assert.ok(out.collections.data.some(x => x.handle === "ethnic-festive"))
  assert.ok(!JSON.stringify(out).includes(draft.id), "the draft is nowhere in what the storefront received")
})
