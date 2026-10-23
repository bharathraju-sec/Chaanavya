// Shared pieces for the catalogue admin pages (Stage 08): API types from the OpenAPI document,
// calls with If-Match and the error envelope, and money in exact paise. Runs in the browser; every
// rule is enforced again by the API.
import type { paths } from "@chaanavya/contracts/api/schema"

type Json<T> = T extends { content: { "application/json": infer B } } ? B : never
type Data<P extends keyof paths, M extends "get" | "post" | "patch" | "put"> = paths[P] extends Record<M, { responses: { 200?: infer R; 201?: infer C } }> ? (Json<R> | Json<C>) extends { data: infer D } ? D : never : never

export type AdminProduct = Data<"/api/v1/admin/catalogue/products/{id}", "get">
export type ProductListItem = Data<"/api/v1/admin/catalogue/products", "get"> extends (infer I)[] ? I : never
export type AdminCollection = Data<"/api/v1/admin/catalogue/collections", "get"> extends (infer I)[] ? I : never
export type ImportPreview = Data<"/api/v1/admin/catalogue/import/preview", "post">
export type UploadIntent = Data<"/api/v1/admin/catalogue/products/{id}/media/uploads", "post">

export const RESTRICTIONS = [
  { value: "none", label: "No restriction" },
  { value: "fragrance_liquid", label: "Fragrance (liquid, courier restricted)" },
  { value: "jewellery_high_value", label: "Jewellery (high value, insured)" },
] as const

export const OPTION_NAMES = ["Size", "Colour", "Volume", "Material"] as const

export const CHECKLIST_LABELS: Record<string, string> = {
  claims: "Material, origin and care claims are true and can be backed up",
  pricing: "Prices and compare-at prices are real and final, GST inclusive",
  description: "The description is the final, approved text (not template copy)",
  sizing: "Sizes match the size guide and the garment's measurements",
  shipping: "The shipping restriction is right for couriers",
}

export const STATUS_LABEL: Record<string, string> = { draft: "Draft", active: "Live", archived: "Archived" }

export type Problem = { status: number; message: string; fields: Record<string, string> }
export type Result<T> = { ok: true; data: T; etag: string | null } | { ok: false; problem: Problem }

/** Calls the admin API on this host (the web host forwards it). */
export async function send<T>(method: string, path: string, { body, etag }: { body?: unknown; etag?: string } = {}): Promise<Result<T>> {
  let res: Response
  try {
    res = await fetch(path, {
      method,
      headers: { ...(body !== undefined && { "content-type": "application/json" }), ...(etag && { "if-match": etag }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    return { ok: false, problem: { status: 0, message: "The server could not be reached. Check the connection and try again.", fields: {} } }
  }
  const json = await res.json().catch(() => null)
  if (res.ok) return { ok: true, data: json?.data as T, etag: res.headers.get("etag") }
  const error = json?.error
  const message =
    res.status === 412
      ? "Someone else changed this product after you opened it. Reload to see their changes, then make yours again."
      : res.status === 403
        ? (typeof error === "object" && error?.message) || "Your role cannot make this change."
        : res.status === 401
          ? "Your session ended. Sign in again."
          : typeof error === "object" && error?.message
            ? error.message
            : "The change could not be saved."
  return { ok: false, problem: { status: res.status, message, fields: (typeof error === "object" && error?.fields) || {} } }
}

const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2 })

/** Paise ("249900") to an Indian rupee amount with two decimals, exactly (no float for the paise part). */
export function formatPaise(paise: string | null | undefined) {
  if (!paise) return ""
  const value = BigInt(paise)
  const rupees = value / BigInt(100)
  const rest = (value % BigInt(100)).toString().padStart(2, "0")
  return `${inr.format(Number(rupees)).replace(/\.\d+$/, "")}.${rest}`
}

/** "2,499.50" rupees to "249950" paise, or null when the text is not an amount. */
export function rupeesToPaise(text: string): string | null {
  const match = /^(\d{1,10})(?:\.(\d{1,2}))?$/.exec(text.replace(/[,\s₹]/g, ""))
  if (!match) return null
  return (BigInt(match[1]) * BigInt(100) + BigInt((match[2] ?? "").padEnd(2, "0"))).toString()
}

export const paiseToRupees = (paise: string | null | undefined) => (paise ? `${BigInt(paise) / BigInt(100)}.${(BigInt(paise) % BigInt(100)).toString().padStart(2, "0")}` : "")

/** Base64 SHA-256 of a file, computed in the browser for the signed upload. */
export async function sha256Base64(file: Blob) {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer())
  let binary = ""
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp", "image/avif"]
export const PHOTO_MAX_BYTES = 10 * 1024 * 1024
