// Stage 08 catalogue rules without a database: field and variant validation, publish checks, CSV
// handling and the photo checks. The same functions back the API, the import and the admin pages.
import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { deflateSync, crc32 } from "node:zlib"
import { createHash } from "node:crypto"
import { optionDefinitions, optionKeyOf, paiseOf, publishBlockers, rupeesToPaise, slugify, variantInputs, checklistFor, checklistOf, isDemonstration } from "../../apps/api/src/catalogue/rules.ts"
import { parseCsv, toCsv } from "../../apps/api/src/catalogue/csv.ts"
import { inspectImage, isComplete, sniffType } from "../../apps/api/src/media/inspect.ts"

const fieldsOf = run => {
  try {
    run()
  } catch (error) {
    return Object.keys(error.fields ?? {})
  }
  return []
}

describe("money and handles", () => {
  test("paise are whole numbers only, never floats", () => {
    assert.equal(paiseOf("249900", "p"), BigInt(249900))
    assert.equal(paiseOf(100, "p"), BigInt(100))
    for (const bad of ["12.5", "-1", 1.5, "1e3", "", null, "100000000001"]) assert.deepEqual(fieldsOf(() => paiseOf(bad, "p")), ["p"], String(bad))
    assert.equal(paiseOf("", "p", { optional: true }), null)
  })

  test("rupee amounts from a spreadsheet convert by string arithmetic", () => {
    assert.equal(rupeesToPaise("12,999.50", "price"), BigInt(1299950))
    assert.equal(rupeesToPaise("0.1", "price"), BigInt(10))
    assert.equal(rupeesToPaise("45000", "price"), BigInt(4500000))
    for (const bad of ["12.555", "abc", "-5", "1e5"]) assert.deepEqual(fieldsOf(() => rupeesToPaise(bad, "price")), ["price"], bad)
  })

  test("handles from titles", () => {
    assert.equal(slugify("Royal Oud Eau de Parfum, 50 ml"), "royal-oud-eau-de-parfum-50-ml")
    assert.equal(slugify("Saree & Blouse"), "saree-and-blouse")
    assert.equal(slugify("Café crème"), "cafe-creme")
    assert.equal(slugify("!!!"), "product")
  })
})

describe("variants", () => {
  const options = optionDefinitions([{ name: "size", values: ["S", "M"] }, { name: "Colour", values: ["Indigo"] }])

  test("option names come from the fixed list and values are unique", () => {
    assert.deepEqual(options.map(o => o.name), ["Size", "Colour"])
    assert.deepEqual(fieldsOf(() => optionDefinitions([{ name: "Flavour", values: ["x"] }])), ["options.0.name"])
    assert.deepEqual(fieldsOf(() => optionDefinitions([{ name: "Size", values: ["S", "s"] }])), ["options.0.values"])
    assert.deepEqual(fieldsOf(() => optionDefinitions([{ name: "Size", values: ["S"] }, { name: "SIZE", values: ["M"] }])), ["options.1.name"])
  })

  test("option keys ignore case and order", () => {
    assert.equal(optionKeyOf({ Size: "M", Colour: "Indigo" }), optionKeyOf({ Colour: "indigo ", Size: "m" }))
    assert.equal(optionKeyOf({}), "default")
  })

  test("SKUs are normalised and unique; combinations unique; compare-at above price", () => {
    const ok = variantInputs([{ options: { Size: "S", Colour: "Indigo" }, sku: "kur-s", pricePaise: "100" }], options)
    assert.equal(ok[0].sku, "KUR-S")
    assert.equal(ok[0].taxCategory, "unassigned")
    assert.deepEqual(fieldsOf(() => variantInputs([{ options: { Size: "S", Colour: "Indigo" }, sku: "A", pricePaise: "1" }, { options: { Size: "M", Colour: "Indigo" }, sku: "a", pricePaise: "1" }], options)), ["variants.1.sku"])
    assert.deepEqual(fieldsOf(() => variantInputs([{ options: { Size: "S", Colour: "Indigo" }, sku: "A", pricePaise: "1" }, { options: { size: "s", colour: "INDIGO" }, sku: "B", pricePaise: "1" }], options)), ["variants.1.options"])
    assert.deepEqual(fieldsOf(() => variantInputs([{ options: { Size: "XL", Colour: "Indigo" }, sku: "A", pricePaise: "1" }], options)), ["variants.0.options"])
    assert.deepEqual(fieldsOf(() => variantInputs([{ options: { Size: "S", Colour: "Indigo" }, sku: "A", pricePaise: "500", compareAtPricePaise: "500" }], options)), ["variants.0.compareAtPricePaise"])
    assert.deepEqual(fieldsOf(() => variantInputs([{ options: { Size: "S", Colour: "Indigo" }, sku: "A B", pricePaise: "1" }], options)), ["variants.0.sku"])
    assert.deepEqual(fieldsOf(() => variantInputs([], options)), ["variants"])
  })
})

describe("publish checks", () => {
  const good = {
    title: "Handloom cotton kurta",
    handle: "handloom-cotton-kurta",
    description: "A handloom cotton kurta with a straight cut and side slits, finished by hand.",
    shippingRestriction: "none",
    collections: ["ethnic-festive"],
    variants: [{ sku: "KUR-S", pricePaise: BigInt(249900), compareAtPricePaise: null, taxCategory: "apparel", selectedOptions: [{ name: "Size", value: "S" }] }],
    media: [{ status: "approved", altText: "Front view" }],
  }
  const codes = p => publishBlockers(p).map(b => b.code)

  test("a complete product has no blockers", () => assert.deepEqual(codes(good), []))

  test("each missing piece blocks publishing", () => {
    assert.deepEqual(codes({ ...good, description: "Nice." }), ["description"])
    assert.deepEqual(codes({ ...good, collections: [] }), ["collections"])
    assert.deepEqual(codes({ ...good, variants: [] }), ["variants", "sizing"].filter(c => c !== "sizing"))
    assert.deepEqual(codes({ ...good, variants: [{ ...good.variants[0], pricePaise: BigInt(0) }] }), ["price"])
    assert.deepEqual(codes({ ...good, variants: [{ ...good.variants[0], taxCategory: "unassigned" }] }), ["tax"])
    assert.deepEqual(codes({ ...good, media: [] }), ["media"])
    assert.deepEqual(codes({ ...good, media: [{ status: "approved", altText: " " }] }), ["alt_text"])
    assert.deepEqual(codes({ ...good, media: [...good.media, { status: "pending", altText: null }] }), ["media_pending"])
    assert.deepEqual(codes({ ...good, shippingRestriction: null }), ["shipping"])
    assert.deepEqual(codes({ ...good, variants: [{ ...good.variants[0], selectedOptions: [] }] }), ["sizing"])
  })

  test("fragrance and jewellery need their shipping restriction; synthetic data never publishes", () => {
    assert.deepEqual(codes({ ...good, collections: ["fragrance"] }), ["shipping"])
    assert.deepEqual(codes({ ...good, collections: ["fragrance"], shippingRestriction: "fragrance_liquid" }), [])
    assert.deepEqual(codes({ ...good, collections: ["jewellery"], shippingRestriction: "jewellery_high_value" }), [])
    assert.ok(isDemonstration({ ...good, title: "Synthetic Saree" }))
    assert.ok(isDemonstration({ ...good, variants: [{ ...good.variants[0], sku: "SYN-SKU-1" }] }))
    assert.ok(!isDemonstration(good))
  })

  test("the checklist asks about sizing only for apparel, and every item must be true", () => {
    assert.deepEqual(checklistFor(["fragrance"]), ["claims", "pricing", "description", "shipping"])
    assert.deepEqual(checklistFor(["dresses"]), ["claims", "pricing", "description", "sizing", "shipping"])
    assert.deepEqual(fieldsOf(() => checklistOf({ claims: true, pricing: "yes", description: true, shipping: true }, checklistFor(["fragrance"]))), ["checklist.pricing"])
  })
})

describe("CSV", () => {
  test("quotes, commas, doubled quotes, CRLF and a byte-order mark", () => {
    const rows = parseCsv('﻿a,b,c\r\n"x, y","say ""hi""",\n\nlast,"multi\nline",z')
    assert.deepEqual(rows, [["a", "b", "c"], ["x, y", 'say "hi"', ""], ["last", "multi\nline", "z"]])
    assert.throws(() => parseCsv('a,"open'), /not closed/)
  })

  test("formula cells are neutralised on export and restored on import", () => {
    const csv = toCsv([["=SUM(A1)", "+91 98", "-", "@cmd", "plain"]])
    assert.equal(csv, "'=SUM(A1),'+91 98,'-,'@cmd,plain\r\n")
    assert.deepEqual(parseCsv(csv), [["=SUM(A1)", "+91 98", "-", "@cmd", "plain"]])
  })
})

describe("photo checks", () => {
  const sha = b => createHash("sha256").update(b).digest("base64")
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data])
    const out = Buffer.alloc(12 + data.length)
    out.writeUInt32BE(data.length, 0)
    body.copy(out, 4)
    out.writeUInt32BE(crc32(body), 8 + data.length)
    return out
  }
  const png = (w, h) => {
    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(w, 0)
    ihdr.writeUInt32BE(h, 4)
    ihdr.set([8, 2, 0, 0, 0], 8)
    const raw = Buffer.alloc((w * 3 + 1) * h)
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))])
  }
  const check = (bytes, contentType = "image/png") => inspectImage(bytes, { contentType, byteSize: bytes.length, checksumSha256: sha(bytes) })

  test("a real PNG passes with its dimensions", () => assert.deepEqual(check(png(800, 600)), { ok: true, width: 800, height: 600 }))

  test("types come from the bytes, not the label", () => {
    assert.equal(sniffType(Buffer.from("<svg onload=alert(1)>")), null)
    assert.equal(sniffType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg")
    assert.equal(sniffType(Buffer.from("RIFF\0\0\0\0WEBPVP8 ", "latin1")), "image/webp")
    assert.equal(sniffType(Buffer.from("\0\0\0\x1cftypavif", "latin1")), "image/avif")
    assert.match(check(png(800, 600), "image/webp").problem, /image\/png, not image\/webp/)
    assert.match(check(Buffer.from("GIF89a" + "x".repeat(100))).problem, /not a JPEG, PNG, WebP or AVIF/)
  })

  test("size, checksum, dimensions and completeness are all checked", () => {
    const image = png(800, 600)
    assert.match(inspectImage(image, { contentType: "image/png", byteSize: image.length + 1, checksumSha256: sha(image) }).problem, /declared size/)
    assert.match(inspectImage(image, { contentType: "image/png", byteSize: image.length, checksumSha256: sha(Buffer.from("x")) }).problem, /checksum/)
    assert.match(check(png(399, 2000)).problem, /at least 400 pixels/)
    assert.match(check(png(10_001, 400)).problem, /too large/)
    const broken = Buffer.from(image)
    broken[40] ^= 0xff
    assert.equal(isComplete("image/png", broken), false, "a corrupted chunk fails its CRC")
    assert.equal(isComplete("image/png", Buffer.concat([image, Buffer.from("extra")])), false)
    assert.equal(isComplete("image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0xff, 0xd9])), true)
    assert.equal(isComplete("image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0xff, 0xd9, 1])), false)
    const webp = Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.from([4, 0, 0, 0]), Buffer.from("WEBP", "latin1")])
    assert.equal(isComplete("image/webp", webp), true)
    assert.equal(isComplete("image/webp", Buffer.concat([webp, Buffer.from("xx")])), false)
    const box = (type, size) => Buffer.concat([Buffer.from([0, 0, 0, size]), Buffer.from(type, "latin1"), Buffer.alloc(size - 8)])
    assert.equal(isComplete("image/avif", Buffer.concat([box("ftyp", 16), box("mdat", 12)])), true)
    assert.equal(isComplete("image/avif", Buffer.concat([box("ftyp", 16), box("mdat", 12), Buffer.from("x")])), false)
    assert.equal(isComplete("image/avif", box("ftyp", 16)), false, "no image data")
  })
})
