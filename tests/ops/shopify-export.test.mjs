// Stage 09: the offline Shopify export converter. Runs the script on a made-up export (no real shop
// data) and checks it writes drafts, a count sheet with Shopify quantities as reference only, and a
// mapping report, without network access or Shopify code.
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const EXPORT = [
  "Handle,Title,Body (HTML),Vendor,Type,Tags,Published,Option1 Name,Option1 Value,Option2 Name,Option2 Value,Variant SKU,Variant Grams,Variant Inventory Qty,Variant Price,Variant Compare At Price,Image Src",
  'example-kurta,Example Kurta,"<p>Soft <strong>cotton</strong>.</p><p>Hand wash.</p>",Example,Kurta,"cotton, summer",TRUE,Size,S,Color,Indigo,ex-kurta-s,300,4,1999.00,,https://cdn.example.com/a.jpg',
  "example-kurta,,,,,,,,M,,Indigo,ex-kurta-m,300,2,1999.00,2499.00,https://cdn.example.com/b.jpg",
  "example-kurta,,,,,,,,,,,,,,,,https://cdn.example.com/c.jpg",
  "example-scarf,Example Scarf,,Example,Scarf,,TRUE,Title,Default Title,,,,0,7,499.00,,",
  "=cmd-example,Formula Title,,,,,TRUE,Title,Default Title,,,EX-F,0,1,1.00,,",
].join("\n")

test("a Shopify products export becomes drafts, a count sheet and a mapping report", () => {
  const dir = mkdtempSync(join(tmpdir(), "chv-shopify-"))
  writeFileSync(join(dir, "products_export.csv"), EXPORT)
  const run = spawnSync(process.execPath, ["scripts/import/shopify-export.mjs", join(dir, "products_export.csv"), join(dir, "out")], { encoding: "utf8" })
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /3 products, 3 variants written as drafts/)

  const catalogue = readFileSync(join(dir, "out-catalogue.csv"), "utf8").trim().split("\r\n")
  assert.equal(catalogue[0].split(",")[0], "handle")
  assert.match(catalogue[1], /^example-kurta,Example Kurta,"Soft cotton\.\n\nHand wash\.",Kurta,cotton;summer,,,EX-KURTA-S,Size,S,Colour,Indigo,,,1999\.00,,,,300$/)
  assert.match(catalogue[2], /,EX-KURTA-M,Size,M,Colour,Indigo,,,1999\.00,2499\.00,,,300$/)
  assert.ok(catalogue[3].startsWith("'=cmd-example"), "formula cells are neutralised")

  const count = readFileSync(join(dir, "out-count.csv"), "utf8").trim().split("\r\n")
  assert.deepEqual(count, ["sku,counted,shopify_quantity,note", "EX-KURTA-S,,4,", "EX-KURTA-M,,2,", "EX-F,,1,"], "counted stays empty: Shopify quantities are reference only")

  const mapping = JSON.parse(readFileSync(join(dir, "out-mapping.json"), "utf8"))
  assert.deepEqual(mapping.products["example-kurta"].images, ["https://cdn.example.com/a.jpg", "https://cdn.example.com/b.jpg", "https://cdn.example.com/c.jpg"])
  assert.ok(mapping.skipped.some(s => s.handle === "example-scarf" && /without a SKU/.test(s.why)))
  assert.match(mapping.source.sha256, /^[0-9a-f]{64}$/)
})

test("the converter never contacts Shopify and has no Shopify dependency", () => {
  const source = readFileSync("scripts/import/shopify-export.mjs", "utf8")
  assert.doesNotMatch(source, /fetch\(|https?\.request|@shopify|shopify-api|graphql/i)
  const pkg = JSON.parse(readFileSync("package.json", "utf8"))
  assert.ok(![...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})].some(d => /shopify/i.test(d)))
})
