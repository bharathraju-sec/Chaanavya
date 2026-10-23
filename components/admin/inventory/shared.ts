// Shared pieces for the inventory admin pages (Stage 09): API types from the OpenAPI document and
// labels. Calls reuse the catalogue pages' helper (If-Match, error envelope).
import type { paths } from "@chaanavya/contracts/api/schema"

type Json<T> = T extends { content: { "application/json": infer B } } ? B : never
type Data<P extends keyof paths, M extends "get" | "post" | "patch" | "put"> = paths[P] extends Record<M, { responses: { 200?: infer R; 201?: infer C } }> ? (Json<R> | Json<C>) extends { data: infer D } ? D : never : never

export type Stock = Data<"/api/v1/admin/inventory/stock/{variantId}", "get">
export type Movement = Data<"/api/v1/admin/inventory/stock/{variantId}/movements", "get"> extends (infer I)[] ? I : never
export type Stocktake = Data<"/api/v1/admin/inventory/stocktakes/{id}", "get">
export type StocktakeListItem = Data<"/api/v1/admin/inventory/stocktakes", "get"> extends (infer I)[] ? I : never

export const MOVEMENT_LABEL: Record<string, string> = {
  receipt: "Received",
  correction: "Correction",
  write_off: "Written off",
  reservation: "Held for an order",
  release: "Hold released",
  allocation: "Allocated to a paid order",
  fulfilment: "Shipped",
  return: "Returned",
}

export const ADJUST_REASONS = [
  { value: "found", label: "Found (more than recorded)" },
  { value: "damaged", label: "Damaged" },
  { value: "lost", label: "Lost or missing" },
  { value: "data_entry", label: "Data entry mistake" },
  { value: "other", label: "Other" },
] as const

export const WRITE_OFF_REASONS = [
  { value: "damaged", label: "Damaged" },
  { value: "lost", label: "Lost" },
  { value: "expired", label: "Expired" },
  { value: "sample", label: "Used as a sample" },
  { value: "other", label: "Other" },
] as const

export const STOCKTAKE_STATUS: Record<string, string> = { draft: "Counting", submitted: "Waiting for approval", approved: "Approved and signed", cancelled: "Cancelled" }
export const SOURCE_LABEL: Record<string, string> = { owner_count: "Counted here", owner_csv: "Count file", shopify_export: "Old Shopify export (reference only)" }

const date = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" })
export const when = (iso: string | null | undefined) => (iso ? date.format(new Date(iso)) : "")

/** A fresh key per user action, so a double click or a retried request is applied once. */
export const actionKey = () => `ui-${crypto.randomUUID()}`
