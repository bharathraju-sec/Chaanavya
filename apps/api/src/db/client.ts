// Database client (Stage 04). Owned by the API and the worker since Stage 07: the web host has no
// database access or credentials.
//
// Runtime imports in src/db use relative paths with .ts extensions so Node can load these
// modules directly in integration tests and scripts (tsconfig allowImportingTsExtensions).
import { PrismaPg } from "@prisma/adapter-pg"
import { PrismaClient } from "./generated/client.ts"

export type Db = PrismaClient
export type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0]

/** Local compose database (development-only credentials), used when DATABASE_URL is unset. */
export const LOCAL_DEV_DATABASE_URL = "postgresql://chaanavya:chaanavya_dev_only@127.0.0.1:15432/chaanavya_dev"

export function databaseUrl(env: Readonly<Record<string, string | undefined>> = process.env) {
  const url = env.DATABASE_URL?.trim()
  if (url) return url
  if (env.VERCEL_ENV === "production" || env.VERCEL_ENV === "preview" || env.APP_ENV === "production" || env.APP_ENV === "staging") {
    throw new Error("DATABASE_URL is required outside local development")
  }
  return LOCAL_DEV_DATABASE_URL
}

/** Connection pool size per process (DATABASE_POOL_MAX, default 10). Size it so that every API and worker instance together stay under the database's connection limit. */
export function poolMax(env: Readonly<Record<string, string | undefined>> = process.env) {
  const value = Number(env.DATABASE_POOL_MAX?.trim() || 10)
  return Number.isInteger(value) && value >= 1 && value <= 50 ? value : 10
}

/** A new client for an explicit connection string (scripts, tests). Call $disconnect when done. */
export function createDbClient(connectionString: string = databaseUrl()): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString, max: poolMax() }) })
}

// One client per server process; reused across hot reloads in development.
const globalForDb = globalThis as unknown as { chaanavyaDb?: PrismaClient }

export function db(): PrismaClient {
  globalForDb.chaanavyaDb ??= createDbClient()
  return globalForDb.chaanavyaDb
}
