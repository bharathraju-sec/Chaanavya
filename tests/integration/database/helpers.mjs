// Shared helpers for database integration tests (Stage 04). Each test file creates its own
// throwaway database on the local compose server (`npm run db:up`), migrates it from empty with
// `prisma migrate deploy`, and drops it afterwards. chaanavya_dev is never touched.
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { createDbClient } from "../../../apps/api/src/db/client.ts"

export const ROOT = fileURLToPath(new URL("../../../", import.meta.url))
/** The API workspace owns Prisma since Stage 07: schema, migrations, seed and prisma.config.ts. */
export const API_ROOT = fileURLToPath(new URL("../../../apps/api/", import.meta.url))
const PRISMA_CLI = fileURLToPath(new URL("../../../node_modules/prisma/build/index.js", import.meta.url))

export const urlFor = name => `postgresql://chaanavya:chaanavya_dev_only@127.0.0.1:15432/${name}`

/** Runs SQL through psql inside the compose container. Returns { status, stdout, stderr }. */
export function psql(database, sql, { input, variables = {} } = {}) {
  const vars = Object.entries(variables).flatMap(([k, v]) => ["-v", `${k}=${v}`])
  const args = ["compose", "exec", "-T", "db", "psql", "-U", "chaanavya", "-d", database, "-v", "ON_ERROR_STOP=1", "-At", ...vars, ...(sql ? ["-c", sql] : ["-f", "-"])]
  const result = spawnSync("docker", args, { cwd: ROOT, input, encoding: "utf8" })
  return { status: result.status, stdout: (result.stdout ?? "").trim(), stderr: (result.stderr ?? "").trim() }
}

export function psqlOk(database, sql, options) {
  const result = psql(database, sql, options)
  if (result.status !== 0) throw new Error(`psql failed: ${result.stderr}`)
  return result.stdout
}

export function prisma(args, url) {
  const result = spawnSync(process.execPath, [PRISMA_CLI, ...args], { cwd: API_ROOT, env: { ...process.env, DATABASE_URL: url, APP_ENV: "development" }, encoding: "utf8" })
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` }
}

export function dropDatabase(name) {
  psqlOk("postgres", `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
}

/** Creates an empty database and applies every migration. */
export function freshDatabase(name) {
  dropDatabase(name)
  psqlOk("postgres", `CREATE DATABASE ${name}`)
  const url = urlFor(name)
  const migrate = prisma(["migrate", "deploy"], url)
  if (migrate.status !== 0) throw new Error(`migrate deploy failed:\n${migrate.output}`)
  return { url, migrateOutput: migrate.output, client: createDbClient(url) }
}

/** Flattens a Prisma or driver error so tests can match constraint names and SQLSTATE codes. */
export const describeError = error =>
  [error?.message, error?.code, JSON.stringify(error?.meta ?? {}), error?.cause?.message, error?.cause?.originalCode, JSON.stringify(error?.cause ?? {})].join(" ")

let counter = 0
export const unique = prefix => `${prefix}-${process.pid}-${Date.now()}-${++counter}`

/** Minimal synthetic product with one variant and a stock balance. */
export async function makeVariant(db, { sku = unique("SYN-SKU"), pricePaise = BigInt(199900), onHand = 5, title = "Synthetic variant" } = {}) {
  const product = await db.product.create({ data: { handle: unique("synthetic").toLowerCase(), title: "Synthetic product", status: "active" } })
  const variant = await db.productVariant.create({ data: { productId: product.id, sku, title, optionKey: unique("key"), pricePaise } })
  await db.inventoryBalance.create({ data: { variantId: variant.id, onHand } })
  return { product, variant }
}

export const shippingAddress = { name: "Synthetic Customer", phone: "+916000000000", line1: "1 Example Road", line2: null, landmark: null, city: "Bengaluru", district: "Bengaluru Urban", stateCode: "IN-KA", pinCode: "560001", country: "IN" }

/** Order with consistent totals (prices include tax). */
export const orderData = (overrides = {}) => ({
  email: "synthetic.customer@example.com",
  subtotalPaise: BigInt(199900),
  grandTotalPaise: BigInt(199900),
  shippingAddress,
  submitKey: unique("submit"),
  ...overrides,
})
