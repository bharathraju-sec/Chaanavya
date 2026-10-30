// CHV-S04-001: an empty database migrates, and constraints reject duplicate active SKUs.
// Also: status enums match the Stage 02 contracts, and append-only tables cannot be changed.
import { after, before, describe, test } from "node:test"
import assert from "node:assert/strict"
import * as enums from "../../../apps/api/src/db/generated/enums.ts"
import * as machines from "../../../packages/contracts/src/modules/state-machines.ts"
import { describeError, dropDatabase, freshDatabase, makeVariant, prisma, psql, psqlOk, unique } from "./helpers.mjs"

const NAME = "chaanavya_test_schema"
let db, url, migrateOutput

before(() => ({ client: db, url, migrateOutput } = freshDatabase(NAME)))
after(async () => {
  await db?.$disconnect()
  dropDatabase(NAME)
})

describe("CHV-S04-001 empty database migrates", () => {
  test("migrate deploy applies the init migration and status is clean", () => {
    for (const name of ["20261015000000_init", "20261015120000_auth_and_guest_sessions", "20261015130000_verification_text_id"]) assert.match(migrateOutput, new RegExp(name))
    const status = prisma(["migrate", "status"], url)
    assert.equal(status.status, 0, status.output)
    assert.match(status.output, /Database schema is up to date/)
  })

  test("the migrated database matches schema.prisma (no drift)", () => {
    const diff = prisma(["migrate", "diff", "--from-config-datasource", "--to-schema", "prisma/schema.prisma", "--exit-code"], url)
    assert.equal(diff.status, 0, diff.output)
  })

  test("all 44 tables exist", () => {
    const tables = psqlOk(NAME, "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations' ORDER BY 1").split("\n")
    // 41 through Stage 12; Stage 13 adds the order event trail, staff order actions and recovery cases.
    assert.equal(tables.length, 44, tables.join(", "))
    for (const t of ["user", "role", "auth_session", "account", "verification", "two_factor", "rate_limit", "guest_session", "customer_profile", "address", "collection", "product", "product_variant", "product_media", "inventory_balance", "inventory_movement", "inventory_reservation", "cart", "cart_line", "promotion", "order", "order_item", "payment_attempt", "provider_event", "refund", "shipment", "shipment_tracking_event", "return_request", "audit_event", "media_upload", "outbox_event", "stocktake", "stocktake_line", "cart_request", "cart_contact", "tax_profile", "tax_rate", "checkout_quote", "order_event", "order_admin_action", "order_recovery_case"]) {
      assert.ok(tables.includes(t), `missing table ${t}`)
    }
  })

  test("hand-written constraints, indexes and triggers are present", () => {
    const checks = psqlOk(NAME, "SELECT conname FROM pg_constraint WHERE contype = 'c' AND connamespace = 'public'::regnamespace").split("\n")
    for (const name of ["inventory_balance_available_non_negative", "cart_single_owner", "order_grand_total_consistent", "promotion_value_matches_kind", "cart_line_quantity_range"]) assert.ok(checks.includes(name), name)
    assert.equal(psqlOk(NAME, "SELECT count(*) FROM pg_indexes WHERE indexname = 'product_variant_sku_active_key'"), "1")
    assert.equal(psqlOk(NAME, "SELECT count(*) FROM pg_trigger WHERE tgname IN ('audit_event_append_only', 'inventory_movement_append_only', 'audit_event_no_truncate', 'inventory_movement_no_truncate')"), "4")
  })
})

describe("CHV-S04-001 duplicate active SKUs are rejected", () => {
  test("a second active variant with the same SKU fails", async () => {
    const { product, variant } = await makeVariant(db)
    await assert.rejects(db.productVariant.create({ data: { productId: product.id, sku: variant.sku, title: "Duplicate", optionKey: "other", pricePaise: BigInt(100) } }), error => /product_variant_sku_active_key|23505|P2002/.test(describeError(error)))
  })

  test("an archived variant frees its SKU for a replacement, and history keeps the old row", async () => {
    const { product, variant } = await makeVariant(db)
    await db.productVariant.update({ where: { id: variant.id }, data: { archivedAt: new Date() } })
    const replacement = await db.productVariant.create({ data: { productId: product.id, sku: variant.sku, title: "Replacement", optionKey: "replacement", pricePaise: BigInt(100) } })
    assert.notEqual(replacement.id, variant.id)
    assert.equal(await db.productVariant.count({ where: { sku: variant.sku } }), 2)
    await assert.rejects(db.productVariant.update({ where: { id: variant.id }, data: { archivedAt: null } }), error => /product_variant_sku_active_key|23505|P2002/.test(describeError(error)))
  })

  test("product handles and option combinations are unique", async () => {
    const { product } = await makeVariant(db)
    await assert.rejects(db.product.create({ data: { handle: product.handle, title: "Duplicate handle" } }), error => /23505|P2002/.test(describeError(error)))
    const v = await db.productVariant.create({ data: { productId: product.id, sku: unique("SYN"), title: "A", optionKey: "size=m", pricePaise: BigInt(1) } })
    await assert.rejects(db.productVariant.create({ data: { productId: product.id, sku: unique("SYN"), title: "B", optionKey: v.optionKey, pricePaise: BigInt(1) } }), error => /23505|P2002/.test(describeError(error)))
  })

  test("handles must be URL-safe slugs", async () => {
    await assert.rejects(db.product.create({ data: { handle: "Bad Handle", title: "x" } }), error => /product_handle_format|23514/.test(describeError(error)))
  })
})

describe("constraints back the Stage 02 invariants", () => {
  test("stock can never go negative or below reservations", async () => {
    const { variant } = await makeVariant(db, { onHand: 1 })
    await assert.rejects(db.inventoryBalance.update({ where: { variantId: variant.id }, data: { reserved: 2 } }), error => /inventory_balance_available_non_negative|23514/.test(describeError(error)))
    await assert.rejects(db.inventoryBalance.update({ where: { variantId: variant.id }, data: { onHand: -1 } }), error => /inventory_balance|23514/.test(describeError(error)))
  })

  test("a cart has exactly one owner and sane quantities", async () => {
    const expiresAt = new Date(Date.now() + 86_400_000)
    await assert.rejects(db.cart.create({ data: { expiresAt } }), error => /cart_single_owner|23514/.test(describeError(error)))
    const guest = await db.guestSession.create({ data: { tokenHash: unique("hash"), expiresAt } })
    const cart = await db.cart.create({ data: { guestSessionId: guest.id, expiresAt } })
    const { variant } = await makeVariant(db)
    await assert.rejects(db.cartLine.create({ data: { cartId: cart.id, variantId: variant.id, quantity: 100 } }), error => /cart_line_quantity_range|23514/.test(describeError(error)))
  })

  test("a promotion is a percentage or a fixed amount, not both", async () => {
    const startsAt = new Date()
    await assert.rejects(db.promotion.create({ data: { code: "SYNBOTH", kind: "percent", percentBasisPoints: 1000, amountOffPaise: BigInt(100), startsAt } }), error => /promotion_value_matches_kind|23514/.test(describeError(error)))
    await assert.rejects(db.promotion.create({ data: { code: "lowercase", kind: "percent", percentBasisPoints: 1000, startsAt } }), error => /promotion_code_uppercase|23514/.test(describeError(error)))
    assert.ok(await db.promotion.create({ data: { code: "SYNTEN", kind: "percent", percentBasisPoints: 1000, startsAt } }))
  })

  test("provider events are unique per provider and event ID", async () => {
    const data = { provider: "razorpay", eventId: unique("evt"), fingerprint: "fp", type: "payment.captured" }
    await db.providerEvent.create({ data })
    await assert.rejects(db.providerEvent.create({ data: { ...data, fingerprint: "other" } }), error => /23505|P2002/.test(describeError(error)))
  })
})

describe("append-only ledgers", () => {
  test("audit events cannot be updated, deleted or truncated", async () => {
    const event = await db.auditEvent.create({ data: { action: "test.append_only", actorKind: "system", entityType: "test", entityId: "1", reason: "test", correlationId: unique("corr") } })
    await assert.rejects(db.auditEvent.update({ where: { id: event.id }, data: { reason: "changed" } }), error => /append-only/.test(describeError(error)))
    await assert.rejects(db.auditEvent.delete({ where: { id: event.id } }), error => /append-only/.test(describeError(error)))
    assert.notEqual(psql(NAME, 'TRUNCATE "audit_event"').status, 0)
  })

  test("inventory movements cannot be updated or deleted", async () => {
    const { variant } = await makeVariant(db)
    const movement = await db.inventoryMovement.create({ data: { variantId: variant.id, type: "receipt", quantity: 5, reason: "synthetic receipt", actorKind: "system", referenceType: "adjustment", referenceId: "test" } })
    await assert.rejects(db.inventoryMovement.update({ where: { id: movement.id }, data: { quantity: 50 } }), error => /append-only/.test(describeError(error)))
    await assert.rejects(db.inventoryMovement.delete({ where: { id: movement.id } }), error => /append-only/.test(describeError(error)))
  })
})

describe("one vocabulary: database enums equal the Stage 02 state machines", () => {
  const pairs = [
    ["OrderStatus", "ORDER_STATUSES"],
    ["PaymentStatus", "PAYMENT_STATUSES"],
    ["ReservationStatus", "RESERVATION_STATUSES"],
    ["FulfilmentStatus", "FULFILMENT_STATUSES"],
    ["ShipmentStatus", "SHIPMENT_STATUSES"],
    ["ReturnStatus", "RETURN_STATUSES"],
    ["RefundStatus", "REFUND_STATUSES"],
  ]
  for (const [dbEnum, contract] of pairs) {
    test(`${dbEnum} matches ${contract}`, () => assert.deepEqual(Object.values(enums[dbEnum]), [...machines[contract]]))
  }
})
