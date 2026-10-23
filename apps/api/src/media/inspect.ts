// Checks an uploaded file before it can become a product photo (Stage 08). The declared type is never
// trusted: the first bytes must match it, and only then is the image's header parsed for its size
// (image-size's parser for that one format, so no other parser ever sees the bytes).
import { createHash } from "node:crypto"
import { crc32 } from "node:zlib"
import { HEIF } from "image-size/types/heif"
import { JPG } from "image-size/types/jpg"
import { PNG } from "image-size/types/png"
import { WEBP } from "image-size/types/webp"

export const MEDIA_TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "avif",
} as const
export type MediaType = keyof typeof MEDIA_TYPES

export const MEDIA_LIMITS = {
  maxBytes: 10 * 1024 * 1024,
  /** Shortest side, so photos stay sharp on product pages. */
  minSide: 400,
  maxSide: 10_000,
  /** Guards image processing later (decompression bombs). */
  maxPixels: 50_000_000,
  perProduct: 20,
} as const

const PARSERS = { "image/jpeg": JPG, "image/png": PNG, "image/webp": WEBP, "image/avif": HEIF } as const

export const isMediaType = (value: unknown): value is MediaType => typeof value === "string" && value in MEDIA_TYPES

/** The format the bytes really are, from their signature; null for anything else. */
export function sniffType(bytes: Buffer): MediaType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg"
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png"
  if (bytes.length >= 12 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") return "image/webp"
  if (bytes.length >= 12 && bytes.toString("latin1", 4, 8) === "ftyp" && ["avif", "avis"].includes(bytes.toString("latin1", 8, 12))) return "image/avif"
  return null
}

export const sha256Base64 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("base64")

/**
 * The file's container is whole: no truncated download, no data hidden after the image (a phone's
 * "motion photo" video, an appended archive). PNG chunks must have valid CRCs and end at IEND; a
 * JPEG must end at its end-of-image marker; WebP's RIFF size must match the file; AVIF's top-level
 * boxes must fill the file exactly and include the image data.
 */
export function isComplete(type: MediaType, bytes: Buffer): boolean {
  if (type === "image/png") {
    let offset = 8
    let sawData = false
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset)
      const end = offset + 12 + length
      if (end > bytes.length) return false
      const chunk = bytes.subarray(offset + 4, offset + 8 + length)
      if (crc32(chunk) !== bytes.readUInt32BE(offset + 8 + length)) return false
      const name = bytes.toString("latin1", offset + 4, offset + 8)
      if (name === "IDAT") sawData = true
      if (name === "IEND") return sawData && end === bytes.length
      offset = end
    }
    return false
  }
  if (type === "image/jpeg") return bytes.length > 4 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9
  if (type === "image/webp") return bytes.length >= 12 && bytes.readUInt32LE(4) + 8 + (bytes.readUInt32LE(4) % 2) === bytes.length
  let offset = 0
  let sawData = false
  while (offset + 8 <= bytes.length) {
    let size = bytes.readUInt32BE(offset)
    if (size === 1) {
      if (offset + 16 > bytes.length) return false
      const large = bytes.readBigUInt64BE(offset + 8)
      if (large > BigInt(bytes.length)) return false
      size = Number(large)
    } else if (size === 0) size = bytes.length - offset
    if (size < 8 || offset + size > bytes.length) return false
    if (bytes.toString("latin1", offset + 4, offset + 8) === "mdat") sawData = true
    offset += size
  }
  return sawData && offset === bytes.length
}

export type Inspection = { ok: true; width: number; height: number } | { ok: false; problem: string }

/** Verifies the stored bytes against what the upload declared. */
export function inspectImage(bytes: Buffer, declared: { contentType: string; byteSize: number; checksumSha256: string }): Inspection {
  if (bytes.length !== declared.byteSize) return { ok: false, problem: "the file is not the declared size" }
  if (sha256Base64(bytes) !== declared.checksumSha256) return { ok: false, problem: "the file does not match its checksum" }
  const actual = sniffType(bytes)
  if (!actual) return { ok: false, problem: "the file is not a JPEG, PNG, WebP or AVIF image" }
  if (actual !== declared.contentType) return { ok: false, problem: `the file is ${actual}, not ${declared.contentType}` }
  if (!isComplete(actual, bytes)) return { ok: false, problem: "the image file is incomplete or has extra data; export it again as a standard image" }
  let size: { width?: number; height?: number }
  try {
    const parser = PARSERS[actual]
    const input = new Uint8Array(bytes)
    if (!parser.validate(input)) return { ok: false, problem: "the image could not be read" }
    size = parser.calculate(input)
  } catch {
    return { ok: false, problem: "the image could not be read" }
  }
  const { width = 0, height = 0 } = size
  if (Math.min(width, height) < MEDIA_LIMITS.minSide) return { ok: false, problem: `images must be at least ${MEDIA_LIMITS.minSide} pixels on the shortest side` }
  if (Math.max(width, height) > MEDIA_LIMITS.maxSide || width * height > MEDIA_LIMITS.maxPixels) return { ok: false, problem: "the image is too large in pixels" }
  return { ok: true, width, height }
}
