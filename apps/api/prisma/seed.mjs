// Synthetic development fixtures (Stage 04). Not real merchandise, prices, customers or orders:
// every name says "Synthetic", handles and SKUs start with "synthetic"/"SYN-", emails use the
// reserved example.com domain. Idempotent (upserts). Refuses to run against staging or production.
// Run: npm run db:seed:synthetic   (or `prisma db seed`, which runs this file)
import { resolveEnvironment } from "@chaanavya/shared/config/env"
import { createDbClient, databaseUrl } from "../src/db/client.ts"

const environment = resolveEnvironment(process.env)
if (environment !== "development") {
  console.error(`Refusing to load synthetic fixtures into ${environment}.`)
  process.exit(1)
}

const db = createDbClient(databaseUrl())
// Prices are written as integer paise, never rupee decimals.

const collections = [
  { handle: "synthetic-dresses", title: "Synthetic Dresses" },
  { handle: "synthetic-jewellery", title: "Synthetic Jewellery" },
]

const products = [
  {
    handle: "synthetic-wrap-dress",
    title: "Synthetic Wrap Dress",
    productType: "Dress",
    collection: "synthetic-dresses",
    variants: ["S", "M", "L"].map((size, i) => ({ sku: `SYN-DRS-WRAP-${size}`, title: size, options: [{ name: "Size", value: size }], pricePaise: 199900, stock: [3, 1, 0][i] })),
  },
  {
    handle: "synthetic-pearl-set",
    title: "Synthetic Pearl Set",
    productType: "Jewellery",
    collection: "synthetic-jewellery",
    variants: [{ sku: "SYN-JWL-PEARL", title: "Default", options: [], pricePaise: 499950, stock: 2 }],
  },
]

const optionKey = options => options.map(o => `${o.name.toLowerCase()}=${o.value.toLowerCase()}`).join("|") || "default"

try {
  for (const [position, c] of collections.entries()) {
    await db.collection.upsert({ where: { handle: c.handle }, update: { title: c.title, position }, create: { ...c, position } })
  }
  for (const p of products) {
    const collection = await db.collection.findUniqueOrThrow({ where: { handle: p.collection } })
    const product = await db.product.upsert({
      where: { handle: p.handle },
      update: { title: p.title, productType: p.productType, status: "active" },
      create: { handle: p.handle, title: p.title, productType: p.productType, status: "active", description: "Synthetic fixture for development.", tags: ["synthetic"] },
    })
    await db.productCollection.upsert({
      where: { productId_collectionId: { productId: product.id, collectionId: collection.id } },
      update: {},
      create: { productId: product.id, collectionId: collection.id },
    })
    for (const [i, v] of p.variants.entries()) {
      const existing = await db.productVariant.findFirst({ where: { sku: v.sku, archivedAt: null } })
      const data = { title: v.title, selectedOptions: v.options, optionKey: optionKey(v.options), pricePaise: BigInt(v.pricePaise), position: i, taxCategory: "synthetic" }
      const variant = existing
        ? await db.productVariant.update({ where: { id: existing.id }, data })
        : await db.productVariant.create({ data: { ...data, productId: product.id, sku: v.sku } })
      await db.inventoryBalance.upsert({ where: { variantId: variant.id }, update: {}, create: { variantId: variant.id, onHand: v.stock } })
    }
  }
  const counts = await Promise.all([db.collection.count(), db.product.count(), db.productVariant.count(), db.inventoryBalance.count()])
  console.log(`Synthetic fixtures ready: ${counts[0]} collections, ${counts[1]} products, ${counts[2]} variants, ${counts[3]} stock balances.`)
} finally {
  await db.$disconnect()
}
