// Local database helper (Stage 03). Works only on the `db` service from compose.yaml, through
// `docker compose exec`, so it can never reach a staging or production database.
//
//   npm run db:backup [-- --db <name>]   write backups/<db>-<time>.dump (pg_dump custom format);
//                                        defaults to chaanavya_dev
//   npm run db:restore -- <file> [--into <db>] [--replace-dev]
//                                        restore a dump into a new database (default
//                                        chaanavya_dev_restored); never overwrites chaanavya_dev
//                                        unless --replace-dev is given
//   npm run db:restore-check             seed synthetic rows into a scratch source database, back
//                                        it up, restore into a second scratch database, compare
//                                        fingerprints, then drop both. chaanavya_dev is untouched,
//                                        so Prisma migrations still start from an empty database.
import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const USER = "chaanavya"
const DEV_DB = "chaanavya_dev"
const CHECK_SOURCE = "chaanavya_restore_source"
const CHECK_TARGET = "chaanavya_restore_check"
const DB_NAME = /^[a-z_][a-z0-9_]{0,62}$/

function exec(args, { input, binary = false } = {}) {
  const result = spawnSync("docker", ["compose", "exec", "-T", "db", ...args], { input, encoding: binary ? "buffer" : "utf8", maxBuffer: 1024 * 1024 * 512 })
  if (result.error) throw new Error(`docker is not available: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`${args[0]} failed (exit ${result.status}): ${String(result.stderr).trim()}`)
  return result.stdout
}

const psql = (db, sql) => exec(["psql", "-U", USER, "-d", db, "-v", "ON_ERROR_STOP=1", "-At", "-c", sql]).trim()
const checkName = name => {
  if (!DB_NAME.test(name)) throw new Error(`Invalid database name: ${name}`)
  return name
}
const recreate = name => {
  psql("postgres", `DROP DATABASE IF EXISTS ${checkName(name)} WITH (FORCE)`)
  psql("postgres", `CREATE DATABASE ${name}`)
}

// Row count plus a hash of every row in id order: equal fingerprints mean equal data.
const FINGERPRINT = "SELECT count(*) || ':' || coalesce(md5(string_agg(id || '|' || label || '|' || amount_paise || '|' || created_at, ',' ORDER BY id)), '') FROM dev_seed_check"

function backup(database = DEV_DB) {
  mkdirSync("backups", { recursive: true })
  const file = join("backups", `${checkName(database)}-${new Date().toISOString().replace(/[:.]/g, "-")}.dump`)
  writeFileSync(file, exec(["pg_dump", "-U", USER, "-d", database, "--format=custom", "--no-owner"], { binary: true }))
  console.log(`Backup written: ${file}`)
  return file
}

function restore(file, into, replaceDev = false) {
  if (checkName(into) === DEV_DB && !replaceDev) throw new Error(`Refusing to overwrite ${DEV_DB}; pass --replace-dev to do that on purpose.`)
  recreate(into)
  exec(["pg_restore", "-U", USER, "-d", into, "--no-owner", "--exit-on-error"], { input: readFileSync(file) })
  console.log(`Restored ${file} into ${into}.`)
}

function restoreCheck() {
  recreate(CHECK_SOURCE)
  exec(["psql", "-U", USER, "-d", CHECK_SOURCE, "-v", "ON_ERROR_STOP=1", "-q"], { input: readFileSync(new URL("./db/seed-dev.sql", import.meta.url)) })
  const before = psql(CHECK_SOURCE, FINGERPRINT)
  const file = backup(CHECK_SOURCE)
  restore(file, CHECK_TARGET)
  const after = psql(CHECK_TARGET, FINGERPRINT)
  psql("postgres", `DROP DATABASE IF EXISTS ${CHECK_TARGET} WITH (FORCE)`)
  psql("postgres", `DROP DATABASE IF EXISTS ${CHECK_SOURCE} WITH (FORCE)`)
  console.log(`Source   ${CHECK_SOURCE}: ${before}`)
  console.log(`Restored ${CHECK_TARGET}: ${after}`)
  if (before !== after) {
    console.error("Restore check FAILED: restored data differs from the source.")
    process.exit(1)
  }
  console.log(`Restore check passed: ${before.split(":")[0]} synthetic rows identical after backup and restore.`)
}

const [command, ...rest] = process.argv.slice(2)
const option = name => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : undefined)
try {
  if (command === "backup") backup(option("--db"))
  else if (command === "restore") {
    const file = rest.find((arg, i) => !arg.startsWith("--") && rest[i - 1] !== "--into")
    if (!file) throw new Error("Usage: npm run db:restore -- <file> [--into <db>] [--replace-dev]")
    restore(file, option("--into") ?? `${DEV_DB}_restored`, rest.includes("--replace-dev"))
  } else if (command === "restore-check") restoreCheck()
  else throw new Error("Commands: backup, restore, restore-check")
} catch (error) {
  console.error(error.message)
  process.exit(1)
}
