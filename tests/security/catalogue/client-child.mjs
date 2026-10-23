// Run by client.test.mjs in a child process that has no database settings: it uses the storefront
// catalogue client against an API and prints what came back. Never run on its own.
import { getCollectionPage, getProductPage, listCollections, listProducts } from "../../../lib/catalogue/client.ts"

const [liveHandle, draftHandle] = process.argv.slice(2)
const out = {
  databaseConfigured: Boolean(process.env.DATABASE_URL || process.env.DIRECT_URL || process.env.POSTGRES_URL),
  list: await listProducts({ limit: 5 }),
  live: await getProductPage(liveHandle),
  draft: await getProductPage(draftHandle),
  collection: await getCollectionPage("ethnic-festive"),
  hiddenCollection: await getCollectionPage("no-such-collection"),
  collections: await listCollections(),
}
console.log("RESULT " + JSON.stringify(out))
