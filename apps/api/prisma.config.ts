import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { defineConfig } from "prisma/config"

// Prisma CLI configuration (Stage 04; owned by the API workspace since Stage 07). Prisma 7 does
// not load env files itself; Node's built-in loader reads the repository's .env.local when present.
const ENV_FILE = fileURLToPath(new URL("../../.env.local", import.meta.url))
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE)

// Without DATABASE_URL the CLI targets the local compose database (development credentials only,
// see compose.yaml). Staging and production always set DATABASE_URL explicitly.
const LOCAL_DEV_DATABASE = "postgresql://chaanavya:chaanavya_dev_only@127.0.0.1:54329/chaanavya_dev"

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON prisma/seed.mjs",
  },
  datasource: {
    url: process.env.DATABASE_URL || LOCAL_DEV_DATABASE,
  },
})
