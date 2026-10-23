// Writes the API's OpenAPI document to packages/contracts/openapi/api.json (Stage 07). Run through
// `npm run api:openapi`, which also regenerates the TypeScript types the web host uses. Builds the
// application without listening or connecting to the database.
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { createApiApp, openApiDocument } from "./app.ts"

const target = fileURLToPath(new URL("../../../packages/contracts/openapi/api.json", import.meta.url))
const app = await createApiApp()
await app.init()
const document = openApiDocument(app)
mkdirSync(dirname(target), { recursive: true })
writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`)
await app.close()
console.log(`OpenAPI document written: ${Object.keys(document.paths).length} paths`)
