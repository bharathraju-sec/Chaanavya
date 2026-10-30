// OpenAPI schemas for the API's responses and request bodies (Stage 07). `npm run api:openapi`
// writes the document to packages/contracts/openapi/api.json and generates TypeScript types the
// web host's API client uses (packages/contracts/src/api/schema.ts).
import type { ApiResponseSchemaHost } from "@nestjs/swagger"

/** OpenAPI schema object (not exported from the package root). */
type SchemaObject = ApiResponseSchemaHost["schema"]

const string: SchemaObject = { type: "string" }
const uuid: SchemaObject = { type: "string", format: "uuid" }
const time: SchemaObject = { type: "string", format: "date-time" }
const strings: SchemaObject = { type: "array", items: string }
const object = (properties: Record<string, SchemaObject>, required = Object.keys(properties)): SchemaObject => ({ type: "object", properties, required, additionalProperties: false })

export const Schemas = {
  authError: object({ error: { type: "string", enum: ["unauthenticated", "forbidden", "mfa_required", "account_disabled", "reauthentication_required", "cross_site", "not_found", "rate_limited", "internal_error"] } }),
  apiError: object({ error: object({ code: string, message: string, fields: { type: "object", additionalProperties: string } }, ["code", "message"]) }),
  page: object({ nextCursor: { type: "string", nullable: true } }),
  money: object({ amountPaise: { type: "integer" }, currency: string }),
  health: object({ status: string }),
  ready: object({ status: string, database: string }),
  session: object(
    {
      signedIn: { type: "boolean" },
      user: object({ id: uuid, email: string, emailVerified: { type: "boolean" }, roles: strings, capabilities: strings, twoFactorEnabled: { type: "boolean" }, passedTwoFactor: { type: "boolean" }, twoFactorWaived: { type: "boolean", description: "True only in development with ADMIN_TWO_FACTOR=off" } }),
    },
    ["signedIn"],
  ),
  me: object({ userId: uuid, roles: strings, capabilities: strings }),
  staff: object({ id: uuid, email: string, name: string, roles: strings, twoFactorEnabled: { type: "boolean" }, disabledAt: { ...time, nullable: true }, createdAt: time, etag: string }),
  auditEvent: object(
    {
      id: uuid,
      action: string,
      actorKind: string,
      actorId: { type: "string", nullable: true },
      entityType: string,
      entityId: string,
      reason: string,
      before: { type: "object", nullable: true },
      after: { type: "object", nullable: true },
      correlationId: string,
      occurredAt: time,
    },
    ["id", "action", "actorKind", "actorId", "entityType", "entityId", "reason", "correlationId", "occurredAt"],
  ),
  setting: object({ name: string, kind: { type: "string", enum: ["secret", "public", "config"] }, services: strings, required: { type: "boolean" }, status: { type: "string", enum: ["set", "missing"] } }),
  problem: object({ name: string, problem: string }),
  reason: object({ reason: { type: "string", minLength: 3, maxLength: 500 } }),
  grant: object({ role: { type: "string", enum: ["OWNER", "ADMIN", "STAFF"] }, reason: { type: "string", minLength: 3, maxLength: 500 } }),
  claim: object({ orderNumber: { type: "string", pattern: "^CHV-\\d{6,12}$" } }),
} satisfies Record<string, SchemaObject>

export const data = (schema: SchemaObject): SchemaObject => object({ data: schema })
export const list = (schema: SchemaObject): SchemaObject => object({ data: { type: "array", items: schema }, page: Schemas.page })

// ---- catalogue (Stage 08) ------------------------------------------------------------------

const nullable = (schema: SchemaObject): SchemaObject => ({ ...schema, nullable: true })
const paise: SchemaObject = { type: "string", pattern: "^[0-9]+$", description: "Whole paise as a digit string (exact)" }
const productStatus: SchemaObject = { type: "string", enum: ["draft", "active", "archived"] }
const restriction: SchemaObject = { type: "string", enum: ["none", "fragrance_liquid", "jewellery_high_value"] }
const option: SchemaObject = object({ name: string, values: strings })
const reasonText: SchemaObject = { type: "string", minLength: 3, maxLength: 500 }

// Published-product read projection (Stage 10.02): exactly the fields in PUBLIC_*_FIELDS
// (packages/contracts/src/modules/catalogue.ts); nothing else may appear.
const legacy = nullable(object({ shopifyGid: string }))
const publicMoney = object({ amountPaise: { type: "integer" }, currency: string })
const publicMedia = object({ id: uuid, url: string, altText: nullable(string), width: nullable({ type: "integer" }), height: nullable({ type: "integer" }) })
const publicVariant = object({
  version: { type: "integer", enum: [1] },
  id: uuid,
  sku: string,
  productId: uuid,
  title: string,
  selectedOptions: { type: "array", items: object({ name: string, value: string }) },
  price: publicMoney,
  compareAtPrice: nullable(publicMoney),
  taxCategory: string,
  mediaId: nullable(uuid),
  legacy,
  availableForSale: { type: "boolean", description: "Whether a unit can be bought now; never a stock level" },
})

export const CatalogueSchemas = {
  productListItem: object({
    id: uuid,
    handle: string,
    title: string,
    status: productStatus,
    variantCount: { type: "integer" },
    priceFromPaise: nullable(paise),
    priceToPaise: nullable(paise),
    image: nullable(object({ url: nullable(string), altText: nullable(string) })),
    pendingPhotos: { type: "integer" },
    updatedAt: time,
    etag: string,
  }),
  product: object({
    id: uuid,
    handle: string,
    status: productStatus,
    title: string,
    description: string,
    productType: string,
    tags: strings,
    shippingRestriction: nullable(restriction),
    publishedAt: nullable(time),
    approvedAt: nullable(time),
    updatedAt: time,
    handleLocked: { type: "boolean" },
    collections: { type: "array", items: object({ id: uuid, handle: string, title: string }) },
    options: { type: "array", items: option },
    variants: {
      type: "array",
      items: object({
        id: uuid,
        sku: string,
        title: string,
        options: { type: "object", additionalProperties: string },
        pricePaise: paise,
        compareAtPricePaise: nullable(paise),
        currency: string,
        taxCategory: string,
        hsnCode: nullable(string),
        weightGrams: nullable({ type: "integer" }),
        mediaId: nullable(uuid),
      }),
    },
    media: {
      type: "array",
      items: object({
        id: uuid,
        status: { type: "string", enum: ["pending", "approved", "rejected"] },
        url: nullable(string),
        previewUrl: nullable(string),
        altText: nullable(string),
        width: nullable({ type: "integer" }),
        height: nullable({ type: "integer" }),
        byteSize: nullable({ type: "integer" }),
        contentType: nullable(string),
        position: { type: "integer" },
      }),
    },
    checklist: { type: "array", items: { type: "string", enum: ["claims", "pricing", "description", "sizing", "shipping"] } },
    blockers: { type: "array", items: object({ code: string, message: string }) },
    etag: string,
  }),
  collection: object({ id: uuid, handle: string, title: string, description: string, hidden: { type: "boolean" }, position: { type: "integer" }, storefront: { type: "boolean" }, productCount: { type: "integer" }, etag: string }),
  productInput: { type: "object", properties: { title: string, handle: string, description: string, productType: string, tags: strings, shippingRestriction: nullable(restriction), collectionIds: { type: "array", items: uuid }, reason: reasonText } },
  collectionInput: { type: "object", properties: { handle: string, title: string, description: string, hidden: { type: "boolean" }, position: { type: "integer" }, reason: reasonText } },
  variantsInput: {
    type: "object",
    required: ["options", "variants"],
    properties: {
      options: { type: "array", items: option },
      variants: {
        type: "array",
        items: {
          type: "object",
          required: ["options", "sku", "pricePaise"],
          properties: { id: nullable(uuid), options: { type: "object", additionalProperties: string }, sku: string, pricePaise: paise, compareAtPricePaise: nullable(paise), taxCategory: string, hsnCode: nullable(string), weightGrams: nullable({ type: "integer" }), mediaId: nullable(uuid) },
        },
      },
      reason: reasonText,
    },
  },
  statusInput: { type: "object", required: ["reason"], properties: { reason: reasonText, checklist: { type: "object", additionalProperties: { type: "boolean" }, description: "publish only: every item of the product's checklist set to true" } } },
  mediaInput: { type: "object", properties: { altText: string, position: { type: "integer" }, reason: reasonText } },
  uploadInput: object({ contentType: { type: "string", enum: ["image/jpeg", "image/png", "image/webp", "image/avif"] }, byteSize: { type: "integer", minimum: 1, maximum: 10485760 }, checksumSha256: { type: "string", pattern: "^[A-Za-z0-9+/]{43}=$" } }),
  uploadIntent: object({ uploadId: uuid, expiresAt: time, upload: object({ url: string, method: { type: "string", enum: ["PUT"] }, headers: { type: "object", additionalProperties: string } }) }),
  importInput: { type: "object", required: ["csv"], properties: { csv: { type: "string", maxLength: 1048576 }, token: string, reason: reasonText } },
  importPreview: object({
    errors: { type: "array", items: object({ row: { type: "integer" }, field: string, message: string }) },
    products: {
      type: "array",
      items: object({
        handle: string,
        action: { type: "string", enum: ["create", "update"] },
        title: string,
        firstRow: { type: "integer" },
        variants: { type: "array", items: object({ sku: string, action: { type: "string", enum: ["create", "update"] }, pricePaise: paise, beforePricePaise: nullable(paise), title: string }) },
      }),
    },
    summary: object({ productsCreated: { type: "integer" }, productsUpdated: { type: "integer" }, variantsCreated: { type: "integer" }, variantsUpdated: { type: "integer" } }),
    token: nullable(string),
  }),
  importResult: object({ productsCreated: { type: "integer" }, productsUpdated: { type: "integer" }, variantsCreated: { type: "integer" }, variantsUpdated: { type: "integer" } }),
  publicProduct: {
    ...object({
      version: { type: "integer", enum: [1] },
      id: uuid,
      handle: string,
      status: { type: "string", enum: ["active"] },
      title: string,
      description: string,
      productType: string,
      tags: strings,
      collectionIds: { type: "array", items: uuid },
      options: { type: "array", items: option },
      media: { type: "array", items: publicMedia },
      variants: { type: "array", items: publicVariant },
      legacy,
    }),
    description: "CatalogueProductV1 (packages/contracts/src/modules/catalogue.ts)",
  },
  productSelection: object({
    version: { type: "integer", enum: [1] },
    selectedVariantId: uuid,
    selectedBy: { type: "string", enum: ["requested", "first_available", "first"] },
    availableForSale: { type: "boolean", description: "False when the product is published but nothing can be bought now" },
  }),
  publicCollection: object({ version: { type: "integer" }, id: uuid, handle: string, title: string, hidden: { type: "boolean" } }),
  pageInfo: object({ nextCursor: { type: "string", nullable: true } }),
} satisfies Record<string, SchemaObject>

// ---- inventory (Stage 09) ------------------------------------------------------------------

const int: SchemaObject = { type: "integer" }
const reportLine = object({
  variantId: uuid,
  sku: string,
  product: string,
  variant: string,
  books: int,
  counted: int,
  difference: int,
  reference: nullable(int),
  note: string,
  pricePaise: paise,
  currency: string,
  checks: strings,
})

export const InventorySchemas = {
  stock: object({
    variantId: uuid,
    sku: string,
    variantTitle: string,
    product: object({ id: uuid, title: string, handle: string, status: productStatus }),
    archived: { type: "boolean" },
    onHand: int,
    reserved: int,
    allocated: int,
    available: int,
    lowStockThreshold: nullable(int),
    lowStock: { type: "boolean" },
    lastCountedAt: nullable(time),
    sellable: { type: "boolean" },
    etag: string,
  }),
  movement: object({
    id: uuid,
    type: { type: "string", enum: ["receipt", "correction", "reservation", "release", "allocation", "fulfilment", "return", "write_off"] },
    quantity: int,
    reasonCode: string,
    reason: string,
    actorKind: string,
    actorId: nullable(string),
    reference: object({ type: string, id: string }),
    onHandAfter: nullable(int),
    reservedAfter: nullable(int),
    allocatedAfter: nullable(int),
    occurredAt: time,
  }),
  quantityInput: object({ quantity: { type: "integer", minimum: 1, maximum: 100000 }, reason: reasonText }),
  adjustInput: object({ delta: { type: "integer", minimum: -100000, maximum: 100000, description: "Not 0" }, reasonCode: { type: "string", enum: ["found", "damaged", "lost", "data_entry", "other"] }, reason: reasonText }),
  writeOffInput: object({ quantity: { type: "integer", minimum: 1, maximum: 100000 }, reasonCode: { type: "string", enum: ["damaged", "lost", "expired", "sample", "other"] }, reason: reasonText }),
  thresholdInput: object({ lowStockThreshold: nullable({ type: "integer", minimum: 0, maximum: 100000 }) }),
  reasonInput: object({ reason: reasonText }),
  stocktakeInput: { type: "object", properties: { note: string } },
  importInput: { type: "object", required: ["csv"], properties: { csv: { type: "string", maxLength: 1048576 }, source: { type: "string", enum: ["owner_csv", "shopify_export"] }, note: string } },
  linesInput: object({ lines: { type: "array", maxItems: 5000, items: { type: "object", required: ["sku", "counted"], properties: { sku: string, counted: { type: "integer", minimum: 0 }, reference: nullable({ type: "integer", minimum: 0 }), note: string } } } }),
  approveInput: object({ signedName: { type: "string", minLength: 3, maxLength: 120 }, acceptedSkus: strings, statement: { type: "boolean", enum: [true] }, reason: reasonText }),
  stocktakeListItem: object({ id: uuid, status: { type: "string", enum: ["draft", "submitted", "approved", "cancelled"] }, note: string, source: string, lines: int, createdAt: time, approvedAt: nullable(time), signedName: nullable(string) }),
  stocktake: object({
    id: uuid,
    status: { type: "string", enum: ["draft", "submitted", "approved", "cancelled"] },
    note: string,
    source: { type: "string", enum: ["owner_count", "owner_csv", "shopify_export"] },
    createdById: uuid,
    createdAt: time,
    submittedAt: nullable(time),
    approvedById: nullable(uuid),
    approvedAt: nullable(time),
    signedName: nullable(string),
    report: {
      type: "object",
      required: ["lines", "totals"],
      properties: {
        lines: { type: "array", items: reportLine },
        totals: object({ skus: int, counted: int, books: int, discrepancies: int, withChecks: int }),
        approval: { type: "object", additionalProperties: true },
      },
    },
    etag: string,
  }),
} satisfies Record<string, SchemaObject>

// ---- orders (Stage 13.12) ------------------------------------------------------------------

const orderStatus: SchemaObject = { type: "string", enum: ["pending_payment", "needs_review", "confirmed", "completed", "cancelled"] }
const fulfilmentStatus: SchemaObject = { type: "string", enum: ["unfulfilled", "packing", "packed", "handed_over", "cancelled"] }
const paymentStatus: SchemaObject = { type: "string", enum: ["created", "authorized", "captured", "pending_reconciliation", "failed", "expired", "partially_refunded", "refunded"] }
const maskedBuyer = object({ kind: { type: "string", enum: ["customer", "guest"] }, name: { type: "string", description: "First name and last initial" }, email: { type: "string", description: "First letter and domain only" }, phone: { type: "string", description: "Last four digits only" } })
const place = object({ city: string, stateCode: string, pinCode: string })
const fullAddress = object({ name: string, phone: string, line1: string, line2: nullable(string), landmark: nullable(string), city: string, district: string, stateCode: string, pinCode: string })
const caseKind: SchemaObject = { type: "string", enum: ["pending_past_window", "captured_not_confirmed", "hold_overdue", "hold_mismatch", "review_waiting"] }
const caseStatus: SchemaObject = { type: "string", enum: ["open", "resolved", "cleared"] }
const staffAction = object({ id: uuid, kind: { type: "string", enum: ["hold", "release", "note"] }, text: { type: "string", description: "The staff reason or the internal note; never shown to the buyer" }, actorId: uuid, createdAt: time })

export const OrderAdminSchemas = {
  listItem: object({
    id: uuid,
    number: string,
    status: orderStatus,
    fulfilmentStatus,
    paymentStatus: nullable(paymentStatus),
    grandTotal: Schemas.money,
    lines: int,
    held: { type: "boolean" },
    buyer: maskedBuyer,
    deliverTo: place,
    payableUntil: nullable(time),
    createdAt: time,
  }),
  order: object({
    id: uuid,
    number: string,
    status: orderStatus,
    fulfilmentStatus,
    buyer: maskedBuyer,
    deliverTo: place,
    totals: object({ subtotal: Schemas.money, discount: Schemas.money, shipping: Schemas.money, tax: Schemas.money, grandTotal: Schemas.money, pricesIncludeTax: { type: "boolean" } }),
    items: { type: "array", items: object({ sku: string, productTitle: string, variantTitle: string, hsnCode: nullable(string), quantity: int, unitPricePaise: int, discountPaise: int, taxPaise: int, lineTotalPaise: int }) },
    delivery: nullable(object({ courierName: nullable(string), mode: nullable(string), estimatedDeliveryDays: nullable(int) })),
    payments: { type: "array", items: object({ id: uuid, provider: string, mode: string, status: paymentStatus, amountPaise: int, capturedAmountPaise: nullable(int), createdAt: time }) },
    stockHold: nullable(object({ status: { type: "string", enum: ["active", "allocated", "released", "fulfilled"] }, expiresAt: time })),
    exceptions: { type: "array", items: object({ reason: string, paymentAttemptId: nullable(uuid), capturedAmountPaise: nullable(int), occurredAt: time }) },
    events: { type: "array", items: object({ kind: string, fromState: nullable(string), toState: string, actorKind: string, reason: string, occurredAt: time }) },
    hold: nullable(object({ heldAt: time, heldBy: uuid })),
    staffActions: { type: "array", items: staffAction },
    recoveryCases: { type: "array", items: object({ id: uuid, kind: caseKind, status: caseStatus, check: string, detectedAt: time, closedAt: nullable(time) }) },
    payableUntil: nullable(time),
    createdAt: time,
    etag: { type: "string", description: "Send as If-Match to hold or release" },
  }),
  holdInput: object({ reason: { type: "string", minLength: 3, maxLength: 500 } }),
  hold: object({ held: { type: "boolean" }, heldAt: nullable(time), heldBy: nullable(uuid), etag: string }),
  noteInput: object({ text: { type: "string", minLength: 1, maxLength: 1000 } }),
  note: staffAction,
  recoveryCase: object({
    id: uuid,
    orderId: uuid,
    orderNumber: string,
    kind: caseKind,
    status: caseStatus,
    check: { type: "string", description: "What a person should check first; never a payment outcome" },
    facts: { type: "object", description: "Order, payment and stock hold statuses and deadlines as seen; nothing personal", additionalProperties: true },
    detectedAt: time,
    lastSeenAt: time,
    closedAt: nullable(time),
    closedBy: nullable(uuid),
    resolution: nullable(string),
  }),
  contact: object({ name: string, email: string, phone: string, shippingAddress: nullable(fullAddress), billingAddress: nullable(fullAddress) }),
} satisfies Record<string, SchemaObject>
