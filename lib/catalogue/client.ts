// The storefront's server-side client for the public catalogue (Stage 10.06). Pages ask the NestJS API
// over HTTP for published products and collections; this host never queries PostgreSQL and never
// reads the placeholder catalogue (lib/catalog.ts) from here, so production cannot fall back to it.
// Typed from the API's OpenAPI document (packages/contracts/src/api/schema.ts). Server only: client
// components cannot import it (eslint.config.mjs).
//
// These reads are public, so nothing about the visitor is sent (no cookies, no IP): pages stay
// cacheable. Every call has a short timeout and returns `unavailable` instead of throwing when the
// API is slow, down or answers something unexpected, so a page can show a calm "back soon" state.
import type { paths } from "@chaanavya/contracts/api/schema"
import { createLogger } from "@chaanavya/shared/observability/logger"
import { apiTarget, INTERNAL_KEY_HEADER, type ApiTarget } from "@/lib/api/forward"

type Body<P extends keyof paths> = paths[P] extends { get: { responses: { 200: { content: { "application/json": infer T } } } } } ? T : never

type ProductListBody = Body<"/api/v1/catalogue/products">
type ProductBody = Body<"/api/v1/catalogue/products/{handle}">
type CollectionPageBody = Body<"/api/v1/catalogue/collections/{handle}">
type CollectionsBody = Body<"/api/v1/catalogue/collections">

export type PublicProduct = ProductBody["data"]
export type ProductSelection = ProductBody["selection"]
export type PublicCollection = CollectionsBody["data"][number]
export type CollectionPage = CollectionPageBody["data"]
export type ProductList = { products: PublicProduct[]; nextCursor: string | null }
export type CollectionProducts = { collection: PublicCollection; products: PublicProduct[]; nextCursor: string | null }

/** `not_found` is a real answer (a missing or hidden product reads the same); `unavailable` means the catalogue could not be reached or understood. */
export type CatalogueResult<T> = { status: "ok"; data: T } | { status: "not_found" } | { status: "unavailable" }

export const CATALOGUE_TIMEOUT_MS = 5_000
export const CATALOGUE_REVALIDATE_SECONDS = 60
/** How long a read may be reused. CATALOGUE_REVALIDATE_SECONDS (0 to 3600) overrides it; the page tests set 0 so every render reads fresh. */
export function revalidateSeconds(env: Readonly<Record<string, string | undefined>> = process.env) {
  const value = Number(env.CATALOGUE_REVALIDATE_SECONDS)
  return env.CATALOGUE_REVALIDATE_SECONDS?.trim() && Number.isInteger(value) && value >= 0 && value <= 3600 ? value : CATALOGUE_REVALIDATE_SECONDS
}
/** Cache tag for everything read here, so a later stage can refresh the shop when the catalogue changes. */
export const CATALOGUE_TAG = "catalogue"

const HANDLE = /^[a-z0-9][a-z0-9-]{0,254}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_LIMIT = 48

export type PageOptions = { limit?: number; cursor?: string | null }

type Options = { target?: ApiTarget; timeoutMs?: number }

function query(params: Record<string, string | number | null | undefined>) {
  const search = new URLSearchParams()
  for (const [name, value] of Object.entries(params)) if (value !== null && value !== undefined) search.set(name, String(value))
  const text = search.toString()
  return text ? `?${text}` : ""
}

const validPage = ({ limit, cursor }: PageOptions) => (limit === undefined || (Number.isInteger(limit) && limit >= 1 && limit <= MAX_LIMIT)) && (cursor == null || /^[A-Za-z0-9_-]{1,200}$/.test(cursor))

async function read<T>(path: string, { target, timeoutMs = CATALOGUE_TIMEOUT_MS }: Options): Promise<CatalogueResult<T>> {
  const log = createLogger()
  let response: Response
  try {
    const { url, key } = target ?? apiTarget()
    response = await fetch(new URL(path, url), {
      headers: { accept: "application/json", [INTERNAL_KEY_HEADER]: key },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      next: { revalidate: revalidateSeconds(), tags: [CATALOGUE_TAG] },
    } as RequestInit)
  } catch (error) {
    log.warn("catalogue.client_unreachable", { path: path.split("?")[0], reason: error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network" })
    return { status: "unavailable" }
  }
  // 400 is the API refusing a malformed parameter (for example a forged cursor): that page does not exist.
  if (response.status === 404 || response.status === 400) return { status: "not_found" }
  if (!response.ok) {
    log.warn("catalogue.client_error_status", { path: path.split("?")[0], status: response.status })
    return { status: "unavailable" }
  }
  try {
    return { status: "ok", data: (await response.json()) as T }
  } catch {
    log.warn("catalogue.client_bad_body", { path: path.split("?")[0] })
    return { status: "unavailable" }
  }
}

/** Published products, newest first. `collection` narrows to one visible collection's handle. */
export async function listProducts(options: PageOptions & { collection?: string } = {}, call: Options = {}): Promise<CatalogueResult<ProductList>> {
  if (!validPage(options) || (options.collection !== undefined && !HANDLE.test(options.collection))) return { status: "not_found" }
  const result = await read<ProductListBody>(`/api/v1/catalogue/products${query({ collection: options.collection, limit: options.limit, cursor: options.cursor })}`, call)
  return result.status === "ok" ? { status: "ok", data: { products: result.data.data, nextCursor: result.data.page.nextCursor } } : result
}

/** One published product by handle, with the variant to show first (`variantId` is the shopper's choice, if any). */
export async function getProductPage(handle: string, variantId?: string | null, call: Options = {}): Promise<CatalogueResult<{ product: PublicProduct; selection: ProductSelection }>> {
  if (!HANDLE.test(handle) || (variantId != null && !UUID.test(variantId))) return { status: "not_found" }
  const result = await read<ProductBody>(`/api/v1/catalogue/products/${encodeURIComponent(handle)}${query({ variant: variantId })}`, call)
  return result.status === "ok" ? { status: "ok", data: { product: result.data.data, selection: result.data.selection } } : result
}

/** One visible collection and a page of its published products. */
export async function getCollectionPage(handle: string, options: PageOptions = {}, call: Options = {}): Promise<CatalogueResult<CollectionProducts>> {
  if (!HANDLE.test(handle) || !validPage(options)) return { status: "not_found" }
  const result = await read<CollectionPageBody>(`/api/v1/catalogue/collections/${encodeURIComponent(handle)}${query({ limit: options.limit, cursor: options.cursor })}`, call)
  return result.status === "ok" ? { status: "ok", data: { collection: result.data.data.collection, products: result.data.data.products, nextCursor: result.data.page.nextCursor } } : result
}

/** The visible collections, in the owner's order. */
export async function listCollections(call: Options = {}): Promise<CatalogueResult<PublicCollection[]>> {
  const result = await read<CollectionsBody>("/api/v1/catalogue/collections", call)
  return result.status === "ok" ? { status: "ok", data: result.data.data } : result
}
