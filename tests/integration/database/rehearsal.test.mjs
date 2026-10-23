// Definition-of-done rehearsal: synthetic seed, backup, restore, migration status on the restored
// copy, and the rollback script followed by a clean re-migration.
import { after, before, describe, test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readdirSync, readFileSync } from "node:fs"
import { API_ROOT, dropDatabase, freshDatabase, prisma, psqlOk, ROOT } from "./helpers.mjs"

const SOURCE = "chaanavya_test_rehearsal"
const RESTORED = "chaanavya_test_rehearsal_restored"
let source

before(() => ({ client: source } = freshDatabase(SOURCE)))
after(async () => {
  await source?.$disconnect()
  dropDatabase(SOURCE)
  dropDatabase(RESTORED)
})

const FINGERPRINT = "SELECT count(*) || ':' || md5(coalesce(string_agg(sku || '|' || price_paise || '|' || coalesce(archived_at::text, ''), ',' ORDER BY sku), '')) FROM product_variant"
const counts = db => psqlOk(db, "SELECT (SELECT count(*) FROM collection) || '/' || (SELECT count(*) FROM product) || '/' || (SELECT count(*) FROM product_variant) || '/' || (SELECT count(*) FROM inventory_balance)")

const docker = (args, input) => spawnSync("docker", ["compose", "exec", "-T", "db", ...args], { cwd: ROOT, input, maxBuffer: 1024 * 1024 * 64 })

describe("synthetic seed", () => {
  test("loads, and a second run changes nothing", () => {
    const url = `postgresql://chaanavya:chaanavya_dev_only@127.0.0.1:54329/${SOURCE}`
    const first = prisma(["db", "seed"], url)
    assert.equal(first.status, 0, first.output)
    assert.match(first.output, /Synthetic fixtures ready: 6 collections, 2 products, 4 variants, 4 stock balances/)
    const before = psqlOk(SOURCE, FINGERPRINT)
    assert.equal(prisma(["db", "seed"], url).status, 0)
    assert.equal(psqlOk(SOURCE, FINGERPRINT), before)
  })

  test("refuses to run against production", () => {
    const run = spawnSync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "prisma/seed.mjs"], { cwd: API_ROOT, env: { ...process.env, APP_ENV: "production", DATABASE_URL: "postgresql://x:y@example.invalid/db" }, encoding: "utf8" })
    assert.equal(run.status, 1)
    assert.match(run.stderr, /Refusing to load synthetic fixtures into production/)
  })
})

describe("backup and restore of a migrated database", () => {
  test("the restored copy has identical data and an up-to-date migration history", () => {
    const dump = docker(["pg_dump", "-U", "chaanavya", "-d", SOURCE, "--format=custom", "--no-owner"])
    assert.equal(dump.status, 0, String(dump.stderr))
    dropDatabase(RESTORED)
    psqlOk("postgres", `CREATE DATABASE ${RESTORED}`)
    const restore = docker(["pg_restore", "-U", "chaanavya", "-d", RESTORED, "--no-owner", "--exit-on-error"], dump.stdout)
    assert.equal(restore.status, 0, String(restore.stderr))
    assert.equal(psqlOk(RESTORED, FINGERPRINT), psqlOk(SOURCE, FINGERPRINT))
    assert.equal(counts(RESTORED), counts(SOURCE))
    const status = prisma(["migrate", "status"], `postgresql://chaanavya:chaanavya_dev_only@127.0.0.1:54329/${RESTORED}`)
    assert.match(status.output, /Database schema is up to date/)
  })

  test("the rollback scripts, newest first, remove the schema, and migrations re-apply cleanly", () => {
    // Every migration has a rollback script; run them all, newest first.
    const migrations = readdirSync(`${API_ROOT}prisma/migrations`).filter(name => /^\d{14}_/.test(name)).sort().reverse()
    assert.deepEqual(readdirSync(`${API_ROOT}prisma/rollback`).map(f => f.replace(/\.down\.sql$/, "")).sort().reverse(), migrations)
    for (const name of migrations) {
      psqlOk(RESTORED, null, { input: readFileSync(`${API_ROOT}prisma/rollback/${name}.down.sql`, "utf8") })
    }
    assert.equal(psqlOk(RESTORED, "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name <> '_prisma_migrations'"), "0")
    const url = `postgresql://chaanavya:chaanavya_dev_only@127.0.0.1:54329/${RESTORED}`
    const migrate = prisma(["migrate", "deploy"], url)
    assert.equal(migrate.status, 0, migrate.output)
    assert.match(prisma(["migrate", "status"], url).output, /Database schema is up to date/)
  })
})
