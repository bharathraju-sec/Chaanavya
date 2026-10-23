// Stage 07: the NestJS API as its own process (built `apps/api/dist`, started by `npm run
// test:security`'s build step). CHV-S07-001: it starts without the web host, and readiness follows
// the database. Also: only the web host's key opens the API, and the request pipeline's envelopes.
import { after, before, describe, test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { fileURLToPath } from "node:url"
import { dropDatabase, freshDatabase } from "../../integration/database/helpers.mjs"

const API_DIR = fileURLToPath(new URL("../../../apps/api/", import.meta.url))
const DB = "chaanavya_test_s07_service"
const KEY = randomBytes(32).toString("base64url")
const children = []
let url

/** Starts dist/main.js with only the given settings. Resolves with its base URL once it listens, or its exit code. */
function startApi(port, settings) {
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NODE_ENV: "production", API_PORT: String(port), ...settings }
  const child = spawn(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "dist/main.js"], { cwd: API_DIR, env })
  children.push(child)
  let output = ""
  child.stdout.on("data", d => (output += d))
  child.stderr.on("data", d => (output += d))
  return new Promise(resolve => {
    const poll = setInterval(async () => {
      try {
        await fetch(`http://127.0.0.1:${port}/health`)
        clearInterval(poll)
        resolve({ base: `http://127.0.0.1:${port}`, output: () => output })
      } catch {
        /* not listening yet */
      }
    }, 250)
    child.on("exit", code => {
      clearInterval(poll)
      resolve({ exitCode: code, output: () => output })
    })
  })
}

const development = () => ({ APP_ENV: "development", DATABASE_URL: url, API_INTERNAL_KEY: KEY, BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"), BETTER_AUTH_URL: "http://localhost:3000" })
let api

before(async () => {
  const fresh = freshDatabase(DB)
  url = fresh.url
  await fresh.client.$disconnect()
  api = await startApi(5671, development())
  assert.ok(api.base, `the API did not start:\n${api.output()}`)
})

after(() => {
  for (const child of children) child.kill()
  dropDatabase(DB)
})

const get = (path, headers = {}) => fetch(`${api.base}${path}`, { headers })

describe("CHV-S07-001 the API starts on its own; readiness follows the database", () => {
  test("liveness and readiness answer without the key and without the web host", async () => {
    const health = await get("/health")
    assert.equal(health.status, 200)
    assert.deepEqual(await health.json(), { status: "ok" })
    const ready = await get("/ready")
    assert.equal(ready.status, 200)
    assert.deepEqual(await ready.json(), { status: "ready", database: "ok" })
  })

  test("with the database unreachable the process stays alive but is not ready (503)", async () => {
    const down = await startApi(5672, { ...development(), DATABASE_URL: "postgresql://chaanavya:chaanavya_dev_only@127.0.0.1:9/nothing" })
    assert.ok(down.base, down.output())
    assert.equal((await fetch(`${down.base}/health`)).status, 200)
    const ready = await fetch(`${down.base}/ready`)
    assert.equal(ready.status, 503)
    assert.deepEqual(await ready.json(), { status: "unavailable", database: "unreachable" })
    assert.equal(ready.headers.get("cache-control"), "no-store")
  })

  test("outside development it refuses to start with incomplete configuration, naming settings but no values", async () => {
    const refused = await startApi(5673, { APP_ENV: "production", DATABASE_URL: url, BETTER_AUTH_SECRET: "too-short-secret-value" })
    assert.equal(refused.exitCode, 1)
    assert.match(refused.output(), /api\.config_error/)
    assert.match(refused.output(), /API_INTERNAL_KEY/)
    assert.ok(!refused.output().includes("too-short-secret-value"))
    assert.ok(!refused.output().includes("chaanavya_dev_only"))
  })
})

describe("only the web host can call the API", () => {
  test("no key, a wrong key or a key of the wrong length: 401 on API and sign-in routes alike", async () => {
    for (const path of ["/api/v1/session", "/api/v1/admin/me", "/api/auth/get-session", "/api/v1/nothing-here"]) {
      for (const headers of [{}, { "x-chaanavya-internal-key": `${KEY.slice(0, -1)}x` }, { "x-chaanavya-internal-key": "short" }]) {
        const res = await get(path, headers)
        assert.equal(res.status, 401, `${path} ${JSON.stringify(Object.keys(headers))}`)
        assert.deepEqual(await res.json(), { error: "unauthenticated" })
      }
    }
  })

  test("the right key opens the API; browsers get no CORS permission", async () => {
    const res = await get("/api/v1/session", { "x-chaanavya-internal-key": KEY, "x-forwarded-host": "localhost:3000", origin: "https://evil.example" })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { signedIn: false })
    assert.equal(res.headers.get("access-control-allow-origin"), null)
  })
})

describe("request pipeline", () => {
  const key = { "x-chaanavya-internal-key": KEY, "x-forwarded-host": "localhost:3000" }

  test("a well-formed correlation ID is echoed; anything else is replaced", async () => {
    const id = "0f8fad5b-d9cb-469f-a165-70867728950e"
    assert.equal((await get("/api/v1/session", { ...key, "x-correlation-id": id })).headers.get("x-correlation-id"), id)
    const replaced = (await get("/api/v1/session", { ...key, "x-correlation-id": "<script>" })).headers.get("x-correlation-id")
    assert.notEqual(replaced, "<script>")
    assert.match(replaced, /^[0-9a-f-]{36}$/)
  })

  test("unknown routes and malformed IDs answer the not-found envelope, without stack traces", async () => {
    for (const path of ["/api/v1/nothing-here", "/api/v1/orders/not-a-uuid"]) {
      const res = await get(path, key)
      assert.equal(res.status, 404, path)
      assert.deepEqual(await res.json(), { error: "not_found" })
    }
  })

  test("security headers on every answer, and no framework fingerprint", async () => {
    const res = await get("/health")
    assert.equal(res.headers.get("x-content-type-options"), "nosniff")
    assert.equal(res.headers.get("x-frame-options"), "DENY")
    assert.equal(res.headers.get("x-powered-by"), null)
  })
})
